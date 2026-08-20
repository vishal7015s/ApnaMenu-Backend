const mongoose = require('mongoose');

require('dotenv').config({ path: '../.env' });

const MONGODB_URI = 'mongodb://vishalshivhare7015_db_user:BCvhSK8ccz54oHFU@ac-y2e2ejd-shard-00-00.jse7byr.mongodb.net:27017,ac-y2e2ejd-shard-00-01.jse7byr.mongodb.net:27017,ac-y2e2ejd-shard-00-02.jse7byr.mongodb.net:27017/ApnaMenu?ssl=true&replicaSet=atlas-1y1mcj-shard-0&authSource=admin&appName=Cluster0';

const User = require('../models/User');
const Kitchen = require('../models/Kitchen');
const Order = require('../models/Order');

const { razorpayWebhook, verifyPayment, getCustomerHistory } = require('../controllers/order.controller');

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

async function runCustomerPaymentAudit() {
  console.log('========================================================================');
  console.log('   CUSTOMER 100% & 50% PAYMENT + SLOW NET WEBHOOK RECOVERY AUDIT       ');
  console.log('========================================================================\n');

  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB Atlas');

  let customer = await User.findOne({ phone: '9666666661' });
  if (!customer) {
    customer = await User.create({ phone: '9666666661', roles: ['customer'], activeRole: 'customer', name: 'Audit Customer' });
  }

  let seller = await User.findOne({ phone: '9666666662' });
  if (!seller) {
    seller = await User.create({ phone: '9666666662', roles: ['kitchen'], activeRole: 'kitchen', name: 'Audit Seller' });
  }

  let kitchen = await Kitchen.findOne({ ownerId: seller._id });
  if (!kitchen) {
    kitchen = await Kitchen.create({
      ownerId: seller._id,
      ownerName: 'Audit Seller',
      name: 'Audit Hub Kitchen',
      phone: '9666666662',
      address: { street: 'Vijay Nagar', city: 'Indore', pinCode: '452010' },
      location: { type: 'Point', coordinates: [75.8900, 22.7500] },
      isOpen: true,
    });
  }

  const socketEvents = [];
  const mockIo = {
    to: (room) => ({
      emit: (event, payload) => socketEvents.push({ room, event, payload }),
    }),
    emit: (event, payload) => socketEvents.push({ room: 'global', event, payload }),
  };

  let allTestsPassed = true;

  // =========================================================================
  // TEST 1: 100% ONLINE PAYMENT - SLOW NET / APP CLOSED AFTER PAYMENT
  // =========================================================================
  console.log('\n------------------------------------------------------------------------');
  console.log('TEST 1: 100% ONLINE PAYMENT - PHONE DIES / SLOW NET AFTER MONEY DEDUCTION');
  console.log('------------------------------------------------------------------------');

  const rzpOrder100 = `order_test_100_${Date.now()}`;
  const order100 = await Order.create({
    orderId: `AM-100-${Date.now().toString().slice(-4)}`,
    customerId: customer._id,
    customerName: customer.name,
    customerPhone: customer.phone,
    kitchenId: kitchen._id,
    deliveryMethod: 'rider',
    status: 'PENDING_CUSTOMER_PAYMENT',
    paymentType: 'online',
    paymentStatus: 'pending',
    grandTotal: 600,
    onlineAmount: 600,
    cashAmount: 0,
    deliveryFee: 50,
    itemTotal: 520,
    platformFee: 30,
    razorpayOrderId: rzpOrder100,
    items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Paneer Butter Masala', qty: 2, price: 260 }],
    deliveryAddress: { house: '101, Galaxy Tower', city: 'Indore' },
    deliveryLocation: { type: 'Point', coordinates: [75.8900, 22.7500] },
  });

  console.log(`[1a] Customer Order Created: ${order100.orderId} (100% Online = ₹600)`);
  console.log(`[1b] Razorpay Order ID assigned: ${rzpOrder100}`);
  console.log(`[1c] 📵 SIMULATION: Customer bank debits ₹600 -> App immediately crashes/loses internet!`);
  console.log(`     (Client /verify endpoint was NEVER called)`);

  // Webhook fires server-to-server
  console.log(`[1d] 🌐 Razorpay Webhook fires payment.captured to backend...`);
  const webhookReq1 = {
    headers: {},
    body: {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_test_online_100_abc',
            order_id: rzpOrder100,
            amount: 60000,
          },
        },
      },
    },
    app: { get: () => mockIo },
  };
  const webhookRes1 = createMockRes();
  await razorpayWebhook(webhookReq1, webhookRes1);

  // Customer re-opens app and views Order History
  console.log(`[1e] 📱 Customer opens app later -> calls GET /api/orders/customer/history...`);
  const historyReq1 = { user: { id: customer._id }, query: { limit: 10, skip: 0 } };
  const historyRes1 = createMockRes();
  await getCustomerHistory(historyReq1, historyRes1);

  const foundOrder100 = (historyRes1.body?.data || []).find(o => o.orderId === order100.orderId);
  console.log(`     Order visible in Customer History: ${Boolean(foundOrder100)}`);
  console.log(`     Status in History: '${foundOrder100?.status}' | Payment Status: '${foundOrder100?.paymentStatus}'`);

  if (foundOrder100 && foundOrder100.status === 'accepted' && foundOrder100.paymentStatus === 'paid') {
    console.log('  ✅ TEST 1 PASSED: 100% Online order automatically recovered by Webhook & 100% visible in customer history!');
  } else {
    console.error('  ❌ TEST 1 FAILED: Order not updated or missing from customer history');
    allTestsPassed = false;
  }

  // =========================================================================
  // TEST 2: 50% PARTIAL COD PAYMENT - SLOW NET / APP CLOSED AFTER PAYMENT
  // =========================================================================
  console.log('\n------------------------------------------------------------------------');
  console.log('TEST 2: 50% PARTIAL COD - PHONE DIES / SLOW NET AFTER PARTIAL PAYMENT');
  console.log('------------------------------------------------------------------------');

  const rzpOrder50 = `order_test_50_${Date.now()}`;
  const order50 = await Order.create({
    orderId: `AM-50-${Date.now().toString().slice(-4)}`,
    customerId: customer._id,
    customerName: customer.name,
    customerPhone: customer.phone,
    kitchenId: kitchen._id,
    deliveryMethod: 'rider',
    status: 'PENDING_CUSTOMER_PAYMENT',
    paymentType: 'partialCod',
    paymentStatus: 'pending',
    grandTotal: 500,
    onlineAmount: 250, // 50% online
    cashAmount: 250,   // 50% remaining cash
    deliveryFee: 40,
    itemTotal: 430,
    platformFee: 30,
    razorpayOrderId: rzpOrder50,
    items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Dal Makhani Special', qty: 2, price: 215 }],
    deliveryAddress: { house: '202, Silver Park', city: 'Indore' },
    deliveryLocation: { type: 'Point', coordinates: [75.8900, 22.7500] },
  });

  console.log(`[2a] Partial COD Order Created: ${order50.orderId} (Grand Total: ₹500 | Online 50%: ₹250 | Cash at door: ₹250)`);
  console.log(`[2b] Razorpay Order ID assigned: ${rzpOrder50}`);
  console.log(`[2c] 📵 SIMULATION: Customer pays ₹250 online -> Net drops -> App closes!`);

  // Webhook fires server-to-server for ₹250
  console.log(`[2d] 🌐 Razorpay Webhook fires payment.captured to backend for ₹250...`);
  const webhookReq2 = {
    headers: {},
    body: {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_test_partial_50_xyz',
            order_id: rzpOrder50,
            amount: 25000,
          },
        },
      },
    },
    app: { get: () => mockIo },
  };
  const webhookRes2 = createMockRes();
  await razorpayWebhook(webhookReq2, webhookRes2);

  // Customer re-opens app and views Order History
  console.log(`[2e] 📱 Customer opens app -> calls GET /api/orders/customer/history...`);
  const historyRes2 = createMockRes();
  await getCustomerHistory(historyReq1, historyRes2);

  const foundOrder50 = (historyRes2.body?.data || []).find(o => o.orderId === order50.orderId);
  console.log(`     Order visible in Customer History: ${Boolean(foundOrder50)}`);
  console.log(`     Status in History: '${foundOrder50?.status}' | Payment Status: '${foundOrder50?.paymentStatus}'`);
  console.log(`     Online Paid: ₹${foundOrder50?.onlineAmount} | Cash Due at Door: ₹${foundOrder50?.cashAmount}`);

  if (foundOrder50 && foundOrder50.status === 'accepted' && foundOrder50.paymentStatus === 'paid' && foundOrder50.onlineAmount === 250 && foundOrder50.cashAmount === 250) {
    console.log('  ✅ TEST 2 PASSED: 50% Partial COD order automatically recovered by Webhook & correctly shows partial breakdown in history!');
  } else {
    console.error('  ❌ TEST 2 FAILED');
    allTestsPassed = false;
  }

  // =========================================================================
  // TEST 3: CONCURRENCY RACE CONDITION - WEBHOOK & APP VERIFY ARRIVE SIMULTANEOUSLY
  // =========================================================================
  console.log('\n------------------------------------------------------------------------');
  console.log('TEST 3: CONCURRENCY RACE - WEBHOOK & CLIENT VERIFY HIT AT SAME MILLISECOND');
  console.log('------------------------------------------------------------------------');

  const rzpOrderRace = `order_test_race_${Date.now()}`;
  const orderRace = await Order.create({
    orderId: `AM-RC-${Date.now().toString().slice(-4)}`,
    customerId: customer._id,
    kitchenId: kitchen._id,
    status: 'PENDING_CUSTOMER_PAYMENT',
    paymentType: 'online',
    paymentStatus: 'pending',
    grandTotal: 300,
    onlineAmount: 300,
    cashAmount: 0,
    itemTotal: 300,
    deliveryFee: 0,
    platformFee: 0,
    razorpayOrderId: rzpOrderRace,
    items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Paneer Kulcha', qty: 2, price: 150 }],
    deliveryAddress: { house: '303, Sunrise Appt', city: 'Indore' },
    deliveryLocation: { type: 'Point', coordinates: [75.8900, 22.7500] },
  });

  const webhookReq3 = {
    headers: {},
    body: {
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_race_123', order_id: rzpOrderRace, amount: 30000 } },
      },
    },
    app: { get: () => mockIo },
  };

  const clientReq3 = {
    user: { id: customer._id },
    body: {
      orderId: orderRace._id.toString(),
      razorpay_order_id: rzpOrderRace,
      razorpay_payment_id: 'pay_race_123',
      razorpay_signature: 'mock_signature',
    },
    app: { get: () => mockIo },
  };

  // Run both at the exact same moment in parallel
  const [wRes, cRes] = await Promise.all([
    (async () => {
      const res = createMockRes();
      await razorpayWebhook(webhookReq3, res);
      return res;
    })(),
    (async () => {
      const res = createMockRes();
      await verifyPayment(clientReq3, res);
      return res;
    })(),
  ]);

  const orderAfterRace = await Order.findById(orderRace._id);
  console.log(`[3a] Webhook Response Status: ${wRes.statusCode} | Client Verify Status: ${cRes.statusCode}`);
  console.log(`[3b] Final Order Status: '${orderAfterRace.status}' | Payment Status: '${orderAfterRace.paymentStatus}'`);

  if (orderAfterRace.status === 'accepted' && orderAfterRace.paymentStatus === 'paid' && (wRes.statusCode === 200 || cRes.statusCode === 200)) {
    console.log('  ✅ TEST 3 PASSED: Race condition handled atomically without conflicts!');
  } else {
    console.error('  ❌ TEST 3 FAILED');
    allTestsPassed = false;
  }

  // Cleanup test docs
  await Order.deleteMany({ _id: { $in: [order100._id, order50._id, orderRace._id] } });
  await Kitchen.deleteOne({ _id: kitchen._id });
  await User.deleteMany({ _id: { $in: [customer._id, seller._id] } });

  console.log('\n========================================================================');
  if (allTestsPassed) {
    console.log('🎉 100% CUSTOMER PAYMENT & SLOW NET WEBHOOK AUDIT PASSED!');
  } else {
    console.log('❌ SOME TESTS FAILED');
  }
  console.log('========================================================================\n');

  await mongoose.disconnect();
}

runCustomerPaymentAudit().catch(err => {
  console.error('Audit script error:', err);
  process.exit(1);
});
