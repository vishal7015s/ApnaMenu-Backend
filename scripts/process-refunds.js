#!/usr/bin/env node
/**
 * Process orders flagged paymentStatus=refund_pending via Razorpay refund API.
 * Usage: node scripts/process-refunds.js [--dry-run]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const Order = require('../models/Order');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const rzp = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  const orders = await Order.find({ paymentStatus: 'refund_pending' }).lean();
  console.log(`Found ${orders.length} refund_pending orders`);

  for (const order of orders) {
    const paymentId = order.razorpayPaymentId;
    if (!paymentId || paymentId === 'webhook_captured') {
      console.warn(`[SKIP] ${order.orderId} — no razorpayPaymentId`);
      continue;
    }
    const amountPaise = Math.round((order.onlineAmount || order.grandTotal || 0) * 100);
    if (dryRun) {
      console.log(`[DRY-RUN] Would refund ${order.orderId} payment=${paymentId} amount=${amountPaise}`);
      continue;
    }
    try {
      await rzp.payments.refund(paymentId, { amount: amountPaise });
      await Order.updateOne(
        { _id: order._id },
        { $set: { paymentStatus: 'refunded', cancelReason: `${order.cancelReason || ''} | Refund processed`.trim() } }
      );
      console.log(`[OK] Refunded ${order.orderId}`);
    } catch (err) {
      console.error(`[FAIL] ${order.orderId}:`, err.message);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
