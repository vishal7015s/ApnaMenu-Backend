/**
 * Backend failsafe crons for online riders:
 *  1) GPS stale > 15 min → force Off Duty + FCM
 *  2) Continuous duty > 8 hours → force Off Duty + FCM
 *
 * Pattern matches orderAutoCancel / rider search expiry (in-process setInterval).
 * Does not depend on node-cron.
 */
const Rider = require('../models/Rider');
const { forceRiderOffline } = require('./riderDuty.service');

/** Lost GPS / network signal — force offline */
const GPS_STALE_MS = parseInt(process.env.RIDER_GPS_STALE_OFFLINE_MS, 10) || 15 * 60 * 1000;
/** Max continuous shift while isOnline */
const MAX_SHIFT_MS = parseInt(process.env.RIDER_MAX_SHIFT_MS, 10) || 8 * 60 * 60 * 1000;
/** How often the job runs */
const CRON_INTERVAL_MS = parseInt(process.env.RIDER_FAILSAFE_CRON_MS, 10) || 60 * 1000;

let pollInterval = null;

const GPS_STALE_TITLE = 'You are Offline';
const GPS_STALE_BODY =
  'You have been marked Offline because we lost your GPS signal for 15 minutes. Check your internet.';

const MAX_SHIFT_TITLE = 'Shift completed';
const MAX_SHIFT_BODY =
  'Your 8-hour shift is completed. You have been automatically marked Off Duty. Take some rest!';

/**
 * RULE 1 — Ghost buster: online but lastLocationAt older than 15 minutes
 * (or never set while online for 15+ min via updatedAt proxy).
 * Skips riders mid-delivery (activeOrderId set).
 */
async function runGpsStaleOfflineJob(io) {
  const cutoff = new Date(Date.now() - GPS_STALE_MS);

  const filter = {
    isOnline: true,
    activeOrderId: null,
    $or: [
      { lastLocationAt: { $lt: cutoff } },
      { lastLocationAt: null, updatedAt: { $lt: cutoff } },
    ],
  };

  const candidates = await Rider.find(filter)
    .select('_id userId expoPushToken lastLocationAt isOnline activeOrderId')
    .lean();

  let forced = 0;
  for (const r of candidates) {
    try {
      // Re-apply same filters atomically so concurrent location PUTs win the race
      const { offline } = await forceRiderOffline(r, {
        title: GPS_STALE_TITLE,
        body: GPS_STALE_BODY,
        type: 'rider_gps_stale_offline',
        reason: 'gps_stale',
        silent: false, // high-priority tray (user asked notify)
        io,
        extraFilter: {
          activeOrderId: null,
          $or: [
            { lastLocationAt: { $lt: cutoff } },
            { lastLocationAt: null, updatedAt: { $lt: cutoff } },
          ],
        },
      });
      if (offline) forced += 1;
    } catch (err) {
      console.error('[riderFailsafe] GPS stale force failed:', r._id, err.message);
    }
  }

  if (forced > 0) {
    console.log(`[riderFailsafe] GPS-stale: forced ${forced} rider(s) offline`);
  }
  return { forced, scanned: candidates.length };
}

/**
 * RULE 2 — Max 8h continuous shift using dutyStartedAt
 * Backfills dutyStartedAt for legacy online rows so shift clock is fair.
 */
async function runMaxShiftOfflineJob(io) {
  const cutoff = new Date(Date.now() - MAX_SHIFT_MS);

  // Backfill dutyStartedAt for legacy online rows (use updatedAt as approximate session start)
  const legacy = await Rider.find({ isOnline: true, dutyStartedAt: null })
    .select('_id updatedAt')
    .lean();
  for (const r of legacy) {
    await Rider.updateOne(
      { _id: r._id, dutyStartedAt: null },
      { $set: { dutyStartedAt: r.updatedAt || new Date() } }
    ).catch(() => null);
  }

  const filter = {
    isOnline: true,
    activeOrderId: null,
    dutyStartedAt: { $lte: cutoff },
  };

  const candidates = await Rider.find(filter)
    .select('_id userId expoPushToken dutyStartedAt isOnline activeOrderId')
    .lean();

  let forced = 0;
  for (const r of candidates) {
    try {
      const { offline } = await forceRiderOffline(r, {
        title: MAX_SHIFT_TITLE,
        body: MAX_SHIFT_BODY,
        type: 'rider_max_shift_offline',
        reason: 'max_shift',
        silent: false,
        io,
        extraFilter: {
          activeOrderId: null,
          dutyStartedAt: { $lte: cutoff },
        },
      });
      if (offline) forced += 1;
    } catch (err) {
      console.error('[riderFailsafe] max-shift force failed:', r._id, err.message);
    }
  }

  if (forced > 0) {
    console.log(`[riderFailsafe] Max-shift: forced ${forced} rider(s) offline`);
  }
  return { forced, scanned: candidates.length };
}

async function runRiderFailsafeJobs(io) {
  const gps = await runGpsStaleOfflineJob(io);
  const shift = await runMaxShiftOfflineJob(io);
  return { gps, shift };
}

function startRiderFailsafeCron(io, intervalMs = CRON_INTERVAL_MS) {
  if (pollInterval) return;
  // First run shortly after boot so long-stale riders are cleaned without waiting a full interval
  setTimeout(() => {
    runRiderFailsafeJobs(io).catch((err) => {
      console.error('[riderFailsafe] initial run error:', err.message);
    });
  }, 15 * 1000);

  pollInterval = setInterval(() => {
    runRiderFailsafeJobs(io).catch((err) => {
      console.error('[riderFailsafe] job error:', err.message);
    });
  }, intervalMs);

  console.log(
    `[riderFailsafe] cron started (every ${intervalMs}ms) | GPS stale=${GPS_STALE_MS}ms | max shift=${MAX_SHIFT_MS}ms`
  );
}

function stopRiderFailsafeCron() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

module.exports = {
  runGpsStaleOfflineJob,
  runMaxShiftOfflineJob,
  runRiderFailsafeJobs,
  startRiderFailsafeCron,
  stopRiderFailsafeCron,
  GPS_STALE_MS,
  MAX_SHIFT_MS,
};
