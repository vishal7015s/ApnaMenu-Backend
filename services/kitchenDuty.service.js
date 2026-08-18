/**
 * Shared kitchen open/close (on/off duty) side effects.
 * Used by manual toggle and auto-offline (3-strike misses).
 */
const Kitchen = require('../models/Kitchen');
const Order = require('../models/Order');
const { invalidateNearbyCachesForKitchen } = require('./cacheInvalidation.service');
const { sendPushNotification } = require('../config/firebase');

const AUTO_CLOSE_STRIKES = 3;
const AUTO_CLOSE_MESSAGE =
  'Your shop has been automatically closed because you missed 3 consecutive orders. Please go Online again to receive orders.';

/**
 * Apply absolute open/closed state (not a flip).
 * Mirrors toggle-status side effects: pending cancels, nearby cache, socket broadcast.
 *
 * @param {import('mongoose').Document|object|string} kitchenOrId
 * @param {boolean} isOpen
 * @param {{ io?: import('socket.io').Server }} [opts]
 * @returns {Promise<{ kitchen: object, changed: boolean }>}
 */
async function applyKitchenOpenState(kitchenOrId, isOpen, { io } = {}) {
  let kitchen = kitchenOrId;
  if (!kitchen || !kitchen.save) {
    const id = kitchenOrId?._id || kitchenOrId;
    kitchen = await Kitchen.findById(id);
  }
  if (!kitchen) {
    return { kitchen: null, changed: false };
  }

  const nextOpen = !!isOpen;
  if (kitchen.isOpen === nextOpen) {
    return { kitchen, changed: false };
  }

  kitchen.isOpen = nextOpen;
  await kitchen.save();

  if (!kitchen.isOpen) {
    const pendingStatuses = ['placed', 'PENDING_SELLER_APPROVAL'];
    await Order.updateMany(
      { kitchenId: kitchen._id, status: { $in: pendingStatuses } },
      {
        $set: {
          status: 'autoCancelled',
          cancelledAt: Date.now(),
          cancelReason: 'Kitchen closed',
        },
      }
    );
  }

  try {
    await invalidateNearbyCachesForKitchen(kitchen, { logPrefix: '[kitchenDuty]' });
  } catch (cacheErr) {
    console.warn('[kitchenDuty] nearby cache invalidate failed:', cacheErr.message);
  }

  if (io) {
    io.emit('kitchen:statusUpdate', {
      kitchenId: kitchen._id.toString(),
      isOpen: kitchen.isOpen,
    });
  }

  return { kitchen, changed: true };
}

/**
 * Reset consecutive order-miss counter (call on successful seller accept).
 */
async function resetKitchenConsecutiveMisses(kitchenId) {
  if (!kitchenId) return;
  await Kitchen.updateOne({ _id: kitchenId }, { $set: { consecutiveMisses: 0 } });
}

/**
 * After a seller acceptance timeout cancels an order: +1 miss.
 * At 3 strikes while still open → same as manual Off Duty/Closed, plus auto-close notify.
 */
async function recordKitchenAcceptanceMiss(kitchenId, io) {
  if (!kitchenId) return null;

  const kitchen = await Kitchen.findByIdAndUpdate(
    kitchenId,
    { $inc: { consecutiveMisses: 1 } },
    { new: true }
  );
  if (!kitchen) return null;

  console.log(
    `[kitchenDuty] kitchen ${kitchen._id} consecutiveMisses=${kitchen.consecutiveMisses}`
  );

  if (kitchen.consecutiveMisses < AUTO_CLOSE_STRIKES || !kitchen.isOpen) {
    return kitchen;
  }

  const { kitchen: closed, changed } = await applyKitchenOpenState(kitchen, false, { io });

  if (io) {
    io.to(`kitchen_${kitchen._id}`).emit('kitchen:auto_closed', {
      kitchenId: kitchen._id.toString(),
      isOpen: false,
      consecutiveMisses: kitchen.consecutiveMisses,
      message: AUTO_CLOSE_MESSAGE,
    });
  }

  const token = closed?.expoPushToken;
  if (token) {
    try {
      await sendPushNotification(
        token,
        'Shop automatically closed',
        AUTO_CLOSE_MESSAGE,
        {
          type: 'kitchen_auto_closed',
          kitchenId: kitchen._id.toString(),
          consecutiveMisses: String(kitchen.consecutiveMisses),
        }
      );
    } catch (err) {
      console.error('[kitchenDuty] auto-close FCM failed:', err.message);
    }
  }

  if (changed) {
    console.log(
      `[kitchenDuty] Auto-closed kitchen ${kitchen._id} after ${AUTO_CLOSE_STRIKES} consecutive misses`
    );
  }

  return closed || kitchen;
}

module.exports = {
  applyKitchenOpenState,
  resetKitchenConsecutiveMisses,
  recordKitchenAcceptanceMiss,
  AUTO_CLOSE_STRIKES,
  AUTO_CLOSE_MESSAGE,
};
