/**
 * Order acceptance & payment timers — Redis TTL when available, in-memory fallback.
 */
const Order = require('../models/Order');
const { isRedisReady, getRedisClient, initRedis } = require('../config/redis');
const { emitOrderToCustomer } = require('../utils/orderSocketEmit');
const { sanitizeKitchenOrderPayload } = require('../utils/kitchenOrderDto');
const { recordKitchenAcceptanceMiss } = require('./kitchenDuty.service');

const ACCEPTANCE_MS = parseInt(process.env.SELLER_ACCEPT_TIMEOUT_MS, 10) || 60 * 1000;
const PAYMENT_MS = 5 * 60 * 1000;

const memoryTimers = new Map();

function emitToKitchenRoom(io, kitchenId, event, payload) {
  if (!io || !kitchenId) return;
  io.to('kitchen_' + String(kitchenId)).emit(event, sanitizeKitchenOrderPayload(payload));
}

function clearMemoryTimer(key) {
  const id = memoryTimers.get(key);
  if (id) {
    clearTimeout(id);
    memoryTimers.delete(key);
  }
}

function clearOrderTimers(orderId) {
  const id = orderId?.toString?.() || String(orderId);
  ['acceptance', 'payment'].forEach((prefix) => {
    const key = `${prefix}_${id}`;
    clearMemoryTimer(key);
    if (isRedisReady()) {
      getRedisClient().del(`timer:${key}`).catch(() => {});
    }
  });
}

async function emitAutoCancel(io, order, kitchenId) {
  if (!io || !order) return;
  const payload = { orderId: order._id, reason: order.cancelReason };
  emitOrderToCustomer(io, order, 'order:auto_cancelled', payload);
  emitToKitchenRoom(io, kitchenId, 'order:expired', { orderId: order._id });
  emitToKitchenRoom(io, kitchenId, 'order:auto_cancelled', payload);
}

async function emitPaymentTimeout(io, order) {
  if (!io || !order) return;
  const payload = { orderId: order._id, reason: order.cancelReason };
  emitOrderToCustomer(io, order, 'order:payment_timeout', payload);
  emitOrderToCustomer(io, order, 'order:auto_cancelled', payload);
  emitOrderToCustomer(io, order, 'order:statusUpdate', { status: order.status, order });
  emitToKitchenRoom(io, order.kitchenId, 'order:payment_timeout', payload);
  emitToKitchenRoom(io, order.kitchenId, 'order:expired', { orderId: order._id });
  emitToKitchenRoom(io, order.kitchenId, 'order:auto_cancelled', payload);
  emitToKitchenRoom(io, order.kitchenId, 'order:statusUpdate', { status: order.status, order });
}

async function runAcceptanceExpiry(orderId, kitchenId, io) {
  clearMemoryTimer(`acceptance_${orderId}`);
  try {
    // Atomic claim so timer + global reconciliation only count a miss once.
    const orderCheck = await Order.findOneAndUpdate(
      {
        _id: orderId,
        status: { $in: ['PENDING_SELLER_APPROVAL', 'placed'] },
      },
      {
        $set: {
          status: 'autoCancelled',
          cancelledAt: Date.now(),
          cancelReason: 'Kitchen is busy (No response in 1 min)',
        },
      },
      { new: true }
    );

    if (!orderCheck) return;

    await emitAutoCancel(io, orderCheck, kitchenId || orderCheck.kitchenId);

    // 3-strike miss counter → auto Off Duty when threshold reached
    await recordKitchenAcceptanceMiss(kitchenId || orderCheck.kitchenId, io);
  } catch (err) {
    console.error('[orderTimer] acceptance expiry error:', err.message);
  }
}

async function runPaymentExpiry(orderId, io) {
  clearMemoryTimer(`payment_${orderId}`);
  try {
    const orderCheck = await Order.findById(orderId);
    if (orderCheck && orderCheck.status === 'PENDING_CUSTOMER_PAYMENT' && orderCheck.paymentStatus !== 'paid') {
      orderCheck.status = 'autoCancelled';
      orderCheck.cancelledAt = Date.now();
      orderCheck.cancelReason = 'Customer did not complete payment';
      await orderCheck.save();
      await emitPaymentTimeout(io, orderCheck);
    }
  } catch (err) {
    console.error('[orderTimer] payment expiry error:', err.message);
  }
}

function scheduleMemoryTimer(key, delayMs, fn) {
  clearMemoryTimer(key);
  const timerId = setTimeout(fn, delayMs);
  memoryTimers.set(key, timerId);
}

function scheduleAcceptanceTimer(orderId, kitchenId, io, delayMs = ACCEPTANCE_MS) {
  const key = `acceptance_${orderId}`;
  scheduleMemoryTimer(key, delayMs, () => runAcceptanceExpiry(orderId, kitchenId, io));
  if (isRedisReady()) {
    const ttlSec = Math.ceil(delayMs / 1000);
    getRedisClient().set(`timer:${key}`, '1', 'EX', ttlSec).catch(() => {});
  }
}

function schedulePaymentTimer(orderId, io, delayMs = PAYMENT_MS) {
  const key = `payment_${orderId}`;
  scheduleMemoryTimer(key, delayMs, () => runPaymentExpiry(orderId, io));
  if (isRedisReady()) {
    const ttlSec = Math.ceil(delayMs / 1000);
    getRedisClient().set(`timer:${key}`, '1', 'EX', ttlSec).catch(() => {});
  }
}

async function recoverExpiredTimers(io) {
  const acceptanceCutoff = new Date(Date.now() - ACCEPTANCE_MS);
  const paymentCutoff = new Date(Date.now() - PAYMENT_MS);

  const pendingAccept = await Order.find({
    status: { $in: ['placed', 'PENDING_SELLER_APPROVAL'] },
    createdAt: { $lt: acceptanceCutoff },
  }).select('_id kitchenId').lean();

  for (const o of pendingAccept) {
    await runAcceptanceExpiry(o._id, o.kitchenId, io);
  }

  const pendingPay = await Order.find({
    status: 'PENDING_CUSTOMER_PAYMENT',
    paymentStatus: { $ne: 'paid' },
    $or: [{ acceptedAt: { $lt: paymentCutoff } }, { acceptedAt: null, createdAt: { $lt: paymentCutoff } }],
  }).select('_id kitchenId').lean();

  for (const o of pendingPay) {
    await runPaymentExpiry(o._id, io);
  }

  const activeAccept = await Order.find({
    status: { $in: ['placed', 'PENDING_SELLER_APPROVAL'] },
    createdAt: { $gte: acceptanceCutoff },
  }).select('_id kitchenId createdAt').lean();

  for (const o of activeAccept) {
    const remaining = ACCEPTANCE_MS - (Date.now() - new Date(o.createdAt).getTime());
    if (remaining > 0) scheduleAcceptanceTimer(o._id, o.kitchenId, io, remaining);
  }

  const activePay = await Order.find({
    status: 'PENDING_CUSTOMER_PAYMENT',
    paymentStatus: { $ne: 'paid' },
  }).select('_id acceptedAt createdAt').lean();

  for (const o of activePay) {
    const base = o.acceptedAt || o.createdAt;
    const remaining = PAYMENT_MS - (Date.now() - new Date(base).getTime());
    if (remaining > 0) schedulePaymentTimer(o._id, io, remaining);
  }
}

function getTimerStatus() {
  return {
    mode: isRedisReady() ? 'redis' : 'memory',
    activeMemoryTimers: memoryTimers.size,
  };
}

module.exports = {
  initRedis,
  clearOrderTimers,
  scheduleAcceptanceTimer,
  schedulePaymentTimer,
  recoverExpiredTimers,
  runAcceptanceExpiry,
  getTimerStatus,
  ACCEPTANCE_MS,
  PAYMENT_MS,
};
