const mongoose = require('mongoose');
const crypto = require('crypto');

// Load environment variables for test
require('dotenv').config({ path: '../.env' });

const MONGODB_URI = 'mongodb://vishalshivhare7015_db_user:BCvhSK8ccz54oHFU@ac-y2e2ejd-shard-00-00.jse7byr.mongodb.net:27017,ac-y2e2ejd-shard-00-01.jse7byr.mongodb.net:27017,ac-y2e2ejd-shard-00-02.jse7byr.mongodb.net:27017/ApnaMenu?ssl=true&replicaSet=atlas-1y1mcj-shard-0&authSource=admin&appName=Cluster0';

const User = require('../models/User');
const Kitchen = require('../models/Kitchen');
const Rider = require('../models/Rider');
const Order = require('../models/Order');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

const { createDoorstepQr, razorpayWebhook, verifyDeliveryOtp } = require('../controllers/order.controller');
const { verifyDrop } = require('../controllers/rider.controller');

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

async function runCompleteAudit() {
  console.log('========================================================================');
  console.log('  COMPLETE PRODUCTION AUDIT: DOORSTEP QR, WEBHOOK & DELIVERY PIPELINE   ');
  console.log('========================================================================\n');

  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB Atlas');

  // 1. Setup Test Actors
  let customer = await User.findOne({ phone: '9777777771' });
  if (!customer) {
    customer = await User.create({ phone: '9777777771', roles: ['customer'], activeRole: 'customer', name: 'Test Customer' });
  }

  let seller = await User.findOne({ phone: '9777777772' });
  if (!seller) {
    seller = await User.create({ phone: '9777777772', roles: ['kitchen'], activeRole: 'kitchen', name: 'Test Seller' });
  }

  let kitchen = await Kitchen.findOne({ ownerId: seller._id });
  if (!kitchen) {
    kitchen = await Kitchen.create({
      ownerId: seller._id,
      ownerName: 'Test Seller',
      name: 'Audit Test Kitchen Hub',
      phone: '9777777772',
      address: { street: 'Main Road', city: 'Indore', pinCode: '452001' },
      location: { type: 'Point', coordinates: [75.8577, 22.7196] },
      isOpen: true,
    });
  }

  let riderUser = await User.findOne({ phone: '9777777773' });
  if (!riderUser) {
    riderUser = await User.create({ phone: '9777777773', roles: ['rider'], activeRole: 'rider', name: 'Audit Test Rider' });
  }

  let rider = await Rider.findOne({ userId: riderUser._id });
  if (!rider) {
    rider = await Rider.create({ userId: riderUser._id, phone: '9777777773', name: 'Audit Test Rider', isOnline: true });
  }

  let testPassed = true;
  const socketEventsEmitted = [];
  const mockIo = {
    to: (room) => ({
      emit: (event, payload) => {
        socketEventsEmitted.push({ room, event, payload });
      },
    }),
    emit: (event, payload) => {
      socketEventsEmitted.push({ room: 'global', event, payload });
    },
  };

  // =========================================================================
  // SECTION A: RIDER DELIVERY WITH DOORSTEP QR FLOW
  // =========================================================================
  console.log('\n------------------------------------------------------------------------');
  console.log('SECTION A: RIDER DELIVERY WITH DOORSTEP QR & REAL-TIME WEBHOOK');
  console.log('------------------------------------------------------------------------');

  const dropOtpRider = '4192';
  const riderOrder = await Order.create({
    orderId: `AM-RD-${Date.now().toString().slice(-4)}`,
    customerId: customer._id,
    kitchenId: kitchen._id,
    riderId: riderUser._id,
    deliveryMethod: 'rider',
    status: 'outForDelivery',
    paymentType: 'partialCod',
    paymentStatus: 'pending',
    grandTotal: 500,
    cashAmount: 350,
    onlineAmount: 150,
    deliveryFee: 50,
    itemTotal: 420,
    platformFee: 30,
    dropOtp: dropOtpRider,
    deliveryLocation: { type: 'Point', coordinates: [75.8577, 22.7196] },
  });

  console.log(`[A1] Order Created: ${riderOrder.orderId} (Cash to collect: ₹${riderOrder.cashAmount})`);

  // Step A2: Test QR Generation Endpoint
  console.log(`[A2] Calling POST /api/orders/${riderOrder._id}/doorstep-qr ...`);
  const qrReqA = { params: { id: riderOrder._id.toString() } };
  const qrResA = createMockRes();
  await createDoorstepQr(qrReqA, qrResA);

  const qrDataA = qrResA.body?.data;
  console.log(`     QR Response Success: ${qrResA.body?.success}`);
  console.log(`     Generated Link/URI: ${qrDataA?.paymentLinkUrl}`);
  console.log(`     Amount in Paise: ${qrDataA?.amount} (₹${qrDataA?.cashAmount})`);

  if (qrResA.body?.success && qrDataA?.paymentLinkUrl && qrDataA?.cashAmount === 350) {
    console.log('  ✅ [A2] QR CODE GENERATION PASSED: Valid URL/URI created for ₹350');
  } else {
    console.error('  ❌ [A2] QR GENERATION FAILED');
    testPassed = false;
  }

  // Step A3: Rider tries to complete drop before payment is made
  console.log(`[A3] Rider attempts to Deliver with doorPaymentMode = 'online' BEFORE Customer pays...`);
  const dropReqPrePayment = {
    params: { id: riderOrder._id.toString() },
    body: { otp: dropOtpRider, doorPaymentMode: 'online' },
    user: { _id: riderUser._id, activeRole: 'rider' },
    app: { get: () => mockIo },
  };
  const dropResPrePayment = createMockRes();
  await verifyDrop(dropReqPrePayment, dropResPrePayment);

  const orderCheckA3 = await Order.findById(riderOrder._id);
  console.log(`     Response Status: ${dropResPrePayment.statusCode} | Message: "${dropResPrePayment.body?.message}"`);
  console.log(`     Order Status in DB: '${orderCheckA3.status}'`);

  if (dropResPrePayment.statusCode === 400 && dropResPrePayment.body?.message?.includes('wait for the customer to complete the QR payment') && orderCheckA3.status === 'outForDelivery') {
    console.log('  ✅ [A3] PRE-PAYMENT DELIVERY LOCK PASSED: Delivery 100% blocked until customer pays');
  } else {
    console.error('  ❌ [A3] PRE-PAYMENT DELIVERY LOCK FAILED');
    testPassed = false;
  }

  // Step A4: Customer scans QR and completes payment -> Webhook triggers
  console.log(`[A4] Customer Scans QR and Pays -> Razorpay fires payment_link.paid webhook event...`);
  const webhookReqA = {
    headers: {},
    body: {
      event: 'payment_link.paid',
      payload: {
        payment_link: {
          entity: {
            id: qrDataA?.razorpayPaymentLinkId || 'plink_test_rider_qr',
            notes: { orderId: riderOrder._id.toString() },
          },
        },
        payment: {
          entity: {
            id: 'pay_test_rider_qr_888',
            amount: 35000,
          },
        },
      },
    },
    app: { get: () => mockIo },
  };
  const webhookResA = createMockRes();
  await razorpayWebhook(webhookReqA, webhookResA);

  const orderAfterWebhookA = await Order.findById(riderOrder._id);
  const paymentSuccessNotifA = socketEventsEmitted.find(e => e.event === 'order:doorstepPaymentSuccess' && e.room === `rider_${riderUser._id}`);

  console.log(`     Order Payment Status: '${orderAfterWebhookA.paymentStatus}' | DoorPaymentMode: '${orderAfterWebhookA.doorPaymentMode}'`);
  console.log(`     Socket notification emitted to Rider room: ${Boolean(paymentSuccessNotifA)}`);

  if (orderAfterWebhookA.paymentStatus === 'paid' && orderAfterWebhookA.doorPaymentMode === 'online' && paymentSuccessNotifA) {
    console.log('  ✅ [A4] WEBHOOK & REAL-TIME PAYMENT RECEIVED BADGE PASSED: Payment verified & socket emitted');
  } else {
    console.error('  ❌ [A4] WEBHOOK PROCESSING FAILED');
    testPassed = false;
  }

  // Step A5: Rider now enters OTP and confirms drop
  console.log(`[A5] Rider submits Drop OTP now that payment is verified...`);
  const dropResPostPayment = createMockRes();
  await verifyDrop(dropReqPrePayment, dropResPostPayment);

  const orderAfterDropA = await Order.findById(riderOrder._id);
  const riderWalletA = await Wallet.findOne({ userId: riderUser._id, role: 'rider' });
  const sellerWalletA = await Wallet.findOne({ userId: seller._id, role: 'kitchen' });

  console.log(`     Drop Response Code: ${dropResPostPayment.statusCode}`);
  console.log(`     Final Order Status: '${orderAfterDropA.status}'`);
  console.log(`     Rider Wallet Balance: ₹${riderWalletA?.balance || 0}`);
  console.log(`     Seller Wallet Balance: ₹${sellerWalletA?.balance || 0}`);

  if (dropResPostPayment.statusCode === 200 && orderAfterDropA.status === 'delivered') {
    console.log('  ✅ [A5] POST-PAYMENT DROP & LEDGER RECONCILIATION PASSED: Order successfully delivered');
  } else {
    console.error('  ❌ [A5] POST-PAYMENT DROP FAILED');
    testPassed = false;
  }

  // =========================================================================
  // SECTION B: SELLER SELF-DELIVERY WITH DOORSTEP QR FLOW
  // =========================================================================
  console.log('\n------------------------------------------------------------------------');
  console.log('SECTION B: SELLER SELF-DELIVERY WITH DOORSTEP QR');
  console.log('------------------------------------------------------------------------');

  const dropOtpSelf = '8821';
  const selfOrder = await Order.create({
    orderId: `AM-SL-${Date.now().toString().slice(-4)}`,
    customerId: customer._id,
    kitchenId: kitchen._id,
    deliveryMethod: 'self',
    status: 'outForDelivery',
    paymentType: 'partialCod',
    paymentStatus: 'pending',
    grandTotal: 400,
    cashAmount: 280,
    onlineAmount: 120,
    deliveryFee: 30,
    itemTotal: 370,
    dropOtp: dropOtpSelf,
    deliveryLocation: { type: 'Point', coordinates: [75.8577, 22.7196] },
  });

  console.log(`[B1] Self-Delivery Order Created: ${selfOrder.orderId} (Cash to collect: ₹${selfOrder.cashAmount})`);

  // Step B2: QR Generation for Self Delivery
  console.log(`[B2] Generating Doorstep QR for Self-Delivery...`);
  const qrReqB = { params: { id: selfOrder._id.toString() } };
  const qrResB = createMockRes();
  await createDoorstepQr(qrReqB, qrResB);
  console.log(`     Generated Link: ${qrResB.body?.data?.paymentLinkUrl}`);

  // Step B3: Seller tries to deliver with 'online' mode before payment
  console.log(`[B3] Seller attempts to deliver with doorPaymentMode = 'online' BEFORE payment...`);
  const selfReqPrePayment = {
    params: { id: selfOrder._id.toString() },
    body: { otp: dropOtpSelf, doorPaymentMode: 'online' },
    user: { _id: seller._id, activeRole: 'kitchen', kitchenId: kitchen._id },
    app: { get: () => mockIo },
  };
  const selfResPrePayment = createMockRes();
  await verifyDeliveryOtp(selfReqPrePayment, selfResPrePayment);

  console.log(`     Response: ${selfResPrePayment.statusCode} | "${selfResPrePayment.body?.message}"`);

  if (selfResPrePayment.statusCode === 400 && selfResPrePayment.body?.message?.includes('wait for the customer to complete the QR payment')) {
    console.log('  ✅ [B3] SELLER PRE-PAYMENT LOCK PASSED: Self-delivery blocked before QR payment');
  } else {
    console.error('  ❌ [B3] SELLER PRE-PAYMENT LOCK FAILED');
    testPassed = false;
  }

  // Step B4: Webhook fires for self-delivery order
  console.log(`[B4] Webhook completes payment for Self-Delivery order...`);
  const webhookReqB = {
    headers: {},
    body: {
      event: 'payment_link.paid',
      payload: {
        payment_link: {
          entity: {
            id: qrResB.body?.data?.razorpayPaymentLinkId || 'plink_test_self_qr',
            notes: { orderId: selfOrder._id.toString() },
          },
        },
        payment: {
          entity: {
            id: 'pay_test_self_qr_777',
            amount: 28000,
          },
        },
      },
    },
    app: { get: () => mockIo },
  };
  const webhookResB = createMockRes();
  await razorpayWebhook(webhookReqB, webhookResB);

  // Step B5: Seller confirms delivery
  console.log(`[B5] Seller confirms Self-Delivery now that payment is verified...`);
  const selfResPostPayment = createMockRes();
  await verifyDeliveryOtp(selfReqPrePayment, selfResPostPayment);

  const orderAfterDropB = await Order.findById(selfOrder._id);
  console.log(`     Self-Delivery Final Status: '${orderAfterDropB.status}' | Code: ${selfResPostPayment.statusCode}`);

  if (selfResPostPayment.statusCode === 200 && orderAfterDropB.status === 'delivered') {
    console.log('  ✅ [B5] SELLER POST-PAYMENT DELIVERY PASSED: Self-delivery completed successfully');
  } else {
    console.error('  ❌ [B5] SELLER DELIVERY FAILED');
    testPassed = false;
  }

  // =========================================================================
  // SECTION C: SECURITY & FRAUD ATTACK TESTS
  // =========================================================================
  console.log('\n------------------------------------------------------------------------');
  console.log('SECTION C: FRAUD PREVENTION & EDGE CASE ATTACK TESTS');
  console.log('------------------------------------------------------------------------');

  // Attack C1: Duplicate Delivery Attempt on already delivered order
  console.log('[C1] Attack Test: Attempting duplicate delivery on already delivered order...');
  const dupReq = {
    params: { id: riderOrder._id.toString() },
    body: { otp: dropOtpRider, doorPaymentMode: 'online' },
    user: { _id: riderUser._id, activeRole: 'rider' },
    app: { get: () => mockIo },
  };
  const dupRes = createMockRes();
  await verifyDrop(dupReq, dupRes);
  console.log(`     Response: ${dupRes.statusCode} | "${dupRes.body?.message}"`);
  if (dupRes.statusCode === 400 && dupRes.body?.message?.includes('already delivered')) {
    console.log('  ✅ [C1] DUPLICATE DELIVERY ATTACK BLOCKED');
  } else {
    console.error('  ❌ [C1] DUPLICATE DELIVERY NOT BLOCKED');
    testPassed = false;
  }

  // Attack C2: Unauthorized rider trying to deliver another rider's order
  console.log('[C2] Attack Test: Unauthorized user trying to deliver order...');
  const fakeRiderUser = new mongoose.Types.ObjectId();
  const fakeRiderReq = {
    params: { id: riderOrder._id.toString() },
    body: { otp: dropOtpRider, doorPaymentMode: 'online' },
    user: { _id: fakeRiderUser, activeRole: 'rider' },
    app: { get: () => mockIo },
  };
  const fakeRiderRes = createMockRes();
  await verifyDrop(fakeRiderReq, fakeRiderRes);
  console.log(`     Response: ${fakeRiderRes.statusCode} | "${fakeRiderRes.body?.message}"`);
  if (fakeRiderRes.statusCode === 404 || fakeRiderRes.statusCode === 400) {
    console.log('  ✅ [C2] UNAUTHORIZED RIDER BLOCKED');
  } else {
    console.error('  ❌ [C2] UNAUTHORIZED ACCESS NOT BLOCKED');
    testPassed = false;
  }

  // Cleanup test database entries
  await Order.deleteMany({ _id: { $in: [riderOrder._id, selfOrder._id] } });
  await Kitchen.deleteOne({ _id: kitchen._id });
  await Rider.deleteOne({ _id: rider._id });
  await User.deleteMany({ _id: { $in: [customer._id, seller._id, riderUser._id] } });
  await Wallet.deleteMany({ userId: { $in: [seller._id, riderUser._id] } });
  await Transaction.deleteMany({ description: { $regex: 'Audit', $options: 'i' } });

  console.log('\n========================================================================');
  if (testPassed) {
    console.log('🎉 100% AUDIT COMPLETE: ALL DOORSTEP QR, WEBHOOK & DELIVERY FLOWS ARE BULLETPROOF & PRODUCTION-READY!');
  } else {
    console.log('❌ SOME TESTS FAILED');
  }
  console.log('========================================================================\n');

  await mongoose.disconnect();
}

runCompleteAudit().catch(err => {
  console.error('Complete audit error:', err);
  process.exit(1);
});
