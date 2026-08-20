const mongoose = require('mongoose');

const MONGODB_URI = 'mongodb://vishalshivhare7015_db_user:BCvhSK8ccz54oHFU@ac-y2e2ejd-shard-00-00.jse7byr.mongodb.net:27017,ac-y2e2ejd-shard-00-01.jse7byr.mongodb.net:27017,ac-y2e2ejd-shard-00-02.jse7byr.mongodb.net:27017/ApnaMenu?ssl=true&replicaSet=atlas-1y1mcj-shard-0&authSource=admin&appName=Cluster0';

const User = require('../models/User');
const Kitchen = require('../models/Kitchen');
const Rider = require('../models/Rider');
const Order = require('../models/Order');
const Wallet = require('../models/Wallet');
const { verifyDrop } = require('../controllers/rider.controller');
const { verifyDeliveryOtp, razorpayWebhook } = require('../controllers/order.controller');

// Mock Express response helper
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

async function runDeliveryAudit() {
  console.log('================================================================');
  console.log('    DOORSTEP QR PAYMENT & DELIVERY VERIFICATION AUDIT SUITE     ');
  console.log('================================================================\n');

  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB Atlas\n');

  // Setup test customer, kitchen, rider
  let testCustomer = await User.findOne({ phone: '9888888881' });
  if (!testCustomer) {
    testCustomer = await User.create({ phone: '9888888881', roles: ['customer'], activeRole: 'customer', name: 'Test Customer' });
  }

  let testSellerUser = await User.findOne({ phone: '9888888882' });
  if (!testSellerUser) {
    testSellerUser = await User.create({ phone: '9888888882', roles: ['kitchen'], activeRole: 'kitchen', name: 'Test Seller' });
  }

  let testKitchen = await Kitchen.findOne({ ownerId: testSellerUser._id });
  if (!testKitchen) {
    testKitchen = await Kitchen.create({
      ownerId: testSellerUser._id,
      ownerName: 'Test Seller Owner',
      name: 'Audit Test Kitchen',
      phone: '9888888882',
      address: { street: 'Test Street', city: 'Indore', pinCode: '452001' },
      location: { type: 'Point', coordinates: [75.8577, 22.7196] },
      isOpen: true,
    });
  }

  let testRiderUser = await User.findOne({ phone: '9888888883' });
  if (!testRiderUser) {
    testRiderUser = await User.create({ phone: '9888888883', roles: ['rider'], activeRole: 'rider', name: 'Audit Test Rider' });
  }

  let testRider = await Rider.findOne({ userId: testRiderUser._id });
  if (!testRider) {
    testRider = await Rider.create({ userId: testRiderUser._id, phone: '9888888883', name: 'Audit Test Rider', isOnline: true });
  }

  let allPassed = true;

  // -------------------------------------------------------------------------
  // TEST CASE 1: RIDER DELIVERY - ATTEMPT DROP BEFORE QR PAYMENT IS COMPLETED
  // -------------------------------------------------------------------------
  console.log('--- TEST CASE 1: RIDER TRIES TO DELIVER BEFORE QR PAYMENT IS COMPLETED ---');
  const dropOtp1 = '5824';
  const order1 = await Order.create({
    orderId: `AM-AUDIT-${Date.now().toString().slice(-4)}`,
    customerId: testCustomer._id,
    kitchenId: testKitchen._id,
    riderId: testRiderUser._id,
    deliveryMethod: 'rider',
    status: 'outForDelivery',
    paymentType: 'partialCod',
    paymentStatus: 'pending',
    grandTotal: 300,
    cashAmount: 210,
    onlineAmount: 90,
    deliveryFee: 40,
    itemTotal: 250,
    dropOtp: dropOtp1,
    deliveryLocation: { type: 'Point', coordinates: [75.8577, 22.7196] },
  });

  console.log(`  [1a] Order created: ${order1.orderId} | Status: outForDelivery | PaymentStatus: pending`);
  console.log(`  [1b] Rider attempts to complete delivery with doorPaymentMode = 'online' (QR)...`);

  const req1 = {
    params: { id: order1._id.toString() },
    body: { otp: dropOtp1, doorPaymentMode: 'online' },
    user: { _id: testRiderUser._id, activeRole: 'rider' },
    app: { get: () => null },
  };
  const res1 = createMockRes();

  await verifyDrop(req1, res1);

  console.log(`  [1c] Response Code: ${res1.statusCode} | Message: "${res1.body?.message}"`);
  const checkOrder1 = await Order.findById(order1._id);

  if (res1.statusCode === 400 && res1.body?.message?.includes('wait for the customer to complete the QR payment') && checkOrder1.status === 'outForDelivery') {
    console.log('  ✅ TEST CASE 1 PASSED: Delivery was STRICTLY BLOCKED because QR payment is not verified yet!\n');
  } else {
    console.error('  ❌ TEST CASE 1 FAILED: Order was delivered without payment verification!');
    allPassed = false;
  }

  // -------------------------------------------------------------------------
  // TEST CASE 2: CUSTOMER COMPLETES QR PAYMENT VIA RAZORPAY WEBHOOK
  // -------------------------------------------------------------------------
  console.log('--- TEST CASE 2: CUSTOMER SCANS QR & PAYS -> WEBHOOK VERIFIES PAYMENT ---');
  console.log('  [2a] Razorpay Webhook fires payment_link.paid for order ' + order1.orderId);

  const webhookReq = {
    headers: {},
    body: {
      event: 'payment_link.paid',
      payload: {
        payment_link: {
          entity: {
            id: 'plink_test_audit_123',
            notes: { orderId: order1._id.toString() },
          },
        },
        payment: {
          entity: {
            id: 'pay_test_audit_qr_999',
            amount: 21000,
          },
        },
      },
    },
    app: { get: () => null },
  };
  const webhookRes = createMockRes();

  await razorpayWebhook(webhookReq, webhookRes);

  const orderAfterWebhook = await Order.findById(order1._id);
  console.log(`  [2b] Webhook processed: PaymentStatus is now '${orderAfterWebhook.paymentStatus}', doorPaymentMode is '${orderAfterWebhook.doorPaymentMode}'`);

  if (orderAfterWebhook.paymentStatus === 'paid' && orderAfterWebhook.doorPaymentMode === 'online') {
    console.log('  ✅ TEST CASE 2 PASSED: Webhook automatically verified and set paymentStatus = paid!\n');
  } else {
    console.error('  ❌ TEST CASE 2 FAILED: Webhook did not mark paymentStatus as paid!');
    allPassed = false;
  }

  // -------------------------------------------------------------------------
  // TEST CASE 3: RIDER RETRIES DROP AFTER QR PAYMENT VERIFIED -> SHOULD SUCCEED
  // -------------------------------------------------------------------------
  console.log('--- TEST CASE 3: RIDER COMPLETES DROP AFTER QR PAYMENT IS VERIFIED ---');
  const res3 = createMockRes();
  await verifyDrop(req1, res3);

  const orderAfterDrop = await Order.findById(order1._id);
  console.log(`  [3a] Response Code: ${res3.statusCode} | Status: '${orderAfterDrop.status}'`);

  if (res3.statusCode === 200 && orderAfterDrop.status === 'delivered') {
    console.log('  ✅ TEST CASE 3 PASSED: Order successfully delivered after verified QR payment!\n');
  } else {
    console.error('  ❌ TEST CASE 3 FAILED: Could not complete delivery after payment!');
    allPassed = false;
  }

  // -------------------------------------------------------------------------
  // TEST CASE 4: SELLER SELF-DELIVERY - UNPAID QR BLOCKED
  // -------------------------------------------------------------------------
  console.log('--- TEST CASE 4: SELLER SELF-DELIVERY UNPAID QR BLOCK TEST ---');
  const dropOtp2 = '7741';
  const order2 = await Order.create({
    orderId: `AM-AUDIT-SELF-${Date.now().toString().slice(-4)}`,
    customerId: testCustomer._id,
    kitchenId: testKitchen._id,
    deliveryMethod: 'self',
    status: 'outForDelivery',
    paymentType: 'partialCod',
    paymentStatus: 'pending',
    grandTotal: 400,
    cashAmount: 280,
    onlineAmount: 120,
    deliveryFee: 30,
    itemTotal: 370,
    dropOtp: dropOtp2,
    deliveryLocation: { type: 'Point', coordinates: [75.8577, 22.7196] },
  });

  const req4 = {
    params: { id: order2._id.toString() },
    body: { otp: dropOtp2, doorPaymentMode: 'online' },
    user: { _id: testSellerUser._id, activeRole: 'kitchen', kitchenId: testKitchen._id },
    app: { get: () => null },
  };
  const res4 = createMockRes();

  await verifyDeliveryOtp(req4, res4);
  const checkOrder2 = await Order.findById(order2._id);

  console.log(`  [4a] Seller Delivery Response: ${res4.statusCode} | "${res4.body?.message}"`);
  if (res4.statusCode === 400 && res4.body?.message?.includes('wait for the customer to complete the QR payment') && checkOrder2.status === 'outForDelivery') {
    console.log('  ✅ TEST CASE 4 PASSED: Seller self-delivery also strictly blocked before QR payment!\n');
  } else {
    console.error('  ❌ TEST CASE 4 FAILED!');
    allPassed = false;
  }

  // -------------------------------------------------------------------------
  // TEST CASE 5: WRONG OTP REJECTED
  // -------------------------------------------------------------------------
  console.log('--- TEST CASE 5: INVALID DELIVERY OTP REJECTION TEST ---');
  const req5 = {
    params: { id: order2._id.toString() },
    body: { otp: '0000', doorPaymentMode: 'cash' }, // Wrong OTP
    user: { _id: testSellerUser._id, activeRole: 'kitchen', kitchenId: testKitchen._id },
    app: { get: () => null },
  };
  const res5 = createMockRes();
  await verifyDeliveryOtp(req5, res5);

  console.log(`  [5a] Response with Wrong OTP: ${res5.statusCode} | "${res5.body?.message}"`);
  if (res5.statusCode === 400 && res5.body?.message?.includes('Invalid Delivery OTP')) {
    console.log('  ✅ TEST CASE 5 PASSED: Wrong OTP was cleanly rejected!\n');
  } else {
    console.error('  ❌ TEST CASE 5 FAILED!');
    allPassed = false;
  }

  // Cleanup test orders
  await Order.deleteMany({ _id: { $in: [order1._id, order2._id] } });
  await Kitchen.deleteOne({ _id: testKitchen._id });
  await Rider.deleteOne({ _id: testRider._id });
  await User.deleteMany({ _id: { $in: [testCustomer._id, testSellerUser._id, testRiderUser._id] } });

  console.log('================================================================');
  if (allPassed) {
    console.log('🎉 ALL DOORSTEP QR & DELIVERY SECURITY TESTS PASSED (100%)!');
  } else {
    console.log('❌ SOME TESTS FAILED');
  }
  console.log('================================================================');

  await mongoose.disconnect();
}

runDeliveryAudit().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
