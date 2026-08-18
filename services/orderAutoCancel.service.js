/**
 * Background auto-cancel reconciliation — replaces write-on-read in queue fetch.
 * Acceptance expiry goes through orderTimer.runAcceptanceExpiry so 3-strike misses are counted once.
 */
const Order = require('../models/Order');
const { runAcceptanceExpiry, ACCEPTANCE_MS, PAYMENT_MS } = require('./orderTimer.service');

const PENDING_QUEUE_STATUSES = ['placed', 'PENDING_SELLER_APPROVAL'];

let pollInterval = null;

async function runGlobalAutoCancel(io) {
  const acceptanceCutoff = new Date(Date.now() - ACCEPTANCE_MS);
  const paymentCutoff = new Date(Date.now() - PAYMENT_MS);

  const expiredAccept = await Order.find({
    status: { $in: PENDING_QUEUE_STATUSES },
    createdAt: { $lt: acceptanceCutoff },
  })
    .select('_id kitchenId')
    .lean();

  let acceptanceCancelled = 0;
  for (const o of expiredAccept) {
    // Emits customer/kitchen cancel + recordKitchenAcceptanceMiss (idempotent claim)
    await runAcceptanceExpiry(o._id, o.kitchenId, io);
    acceptanceCancelled += 1;
  }

  const payResult = await Order.updateMany(
    {
      status: 'PENDING_CUSTOMER_PAYMENT',
      paymentStatus: { $ne: 'paid' },
      $or: [{ acceptedAt: { $lt: paymentCutoff } }, { acceptedAt: null, createdAt: { $lt: paymentCutoff } }],
    },
    {
      $set: {
        status: 'autoCancelled',
        cancelledAt: Date.now(),
        cancelReason: 'Customer did not complete payment',
      },
    }
  );

  if (io && payResult.modifiedCount > 0) {
    const recent = await Order.find({
      status: 'autoCancelled',
      cancelReason: 'Customer did not complete payment',
      cancelledAt: { $gte: Date.now() - 35000 },
    }).select('_id kitchenId cancelReason').lean();

    for (const o of recent) {
      io.to(`kitchen_${o.kitchenId}`).emit('order:auto_cancelled', {
        orderId: o._id,
        reason: o.cancelReason,
      });
    }
  }

  return {
    acceptanceCancelled,
    paymentCancelled: payResult.modifiedCount,
  };
}

function startAutoCancelJob(io, intervalMs = 30000) {
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    runGlobalAutoCancel(io).catch((err) => {
      console.error('[autoCancel] job error:', err.message);
    });
  }, intervalMs);
}

function stopAutoCancelJob() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

module.exports = { runGlobalAutoCancel, startAutoCancelJob, stopAutoCancelJob };
