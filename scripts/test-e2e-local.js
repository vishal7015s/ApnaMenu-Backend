#!/usr/bin/env node
/**
 * Local smoke test for customer → seller → order APIs.
 * Prints only PASS/FAIL summaries (no tokens).
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const http = require('http');

const User = require('../models/User');
const Kitchen = require('../models/Kitchen');
const MenuItem = require('../models/MenuItem');
const Rider = require('../models/Rider');
const Order = require('../models/Order');

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: 'localhost',
        port: 5000,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode, body: { raw } });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const results = [];
  const pass = (name) => results.push(`PASS ${name}`);
  const fail = (name, msg) => results.push(`FAIL ${name}: ${msg}`);

  await mongoose.connect(process.env.MONGODB_URI);

  const customer = await User.findOne({ role: 'customer' });
  const kitchen = await Kitchen.findOne();
  const menuItem = kitchen ? await MenuItem.findOne({ kitchenId: kitchen._id }) : null;
  const seller = kitchen ? await User.findById(kitchen.ownerId) : null;

  if (!customer || !kitchen || !menuItem || !seller) {
    console.log('FAIL setup: missing seed data (customer/kitchen/menu/seller)');
    process.exit(1);
  }

  const customerToken = jwt.sign({ id: customer._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const sellerToken = jwt.sign({ id: seller._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const otherCustomer = await User.findOne({ role: 'customer', _id: { $ne: customer._id } });

  const stats = await api('GET', '/api/orders/customer/stats', null, customerToken);
  stats.body.success && typeof stats.body.data?.totalOrders === 'number'
    ? pass('customer/order-stats')
    : fail('customer/order-stats', stats.body.message || 'invalid stats');

  const history = await api('GET', '/api/orders/customer/history?limit=5&skip=0', null, customerToken);
  if (history.body.success && Array.isArray(history.body.data) && history.body.pagination) {
    pass('customer/history-pagination');
  } else {
    fail('customer/history-pagination', history.body.message || 'missing pagination');
  }

  const homeNoCoords = await api('GET', '/api/home/feed', null, customerToken);
  homeNoCoords.status === 400 ? pass('customer/home-feed-requires-coords') : fail('customer/home-feed-requires-coords', `status ${homeNoCoords.status}`);

  if (otherCustomer) {
    const otherToken = jwt.sign({ id: otherCustomer._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const foreignVerify = await api(
      'POST',
      '/api/orders/verify',
      {
        orderId: '000000000000000000000000',
        razorpay_order_id: 'order_fake',
        razorpay_payment_id: 'pay_fake',
        razorpay_signature: 'sig_fake',
      },
      otherToken
    );
    (foreignVerify.status === 403 || foreignVerify.status === 404)
      ? pass('customer/verify-payment-ownership')
      : fail('customer/verify-payment-ownership', `status ${foreignVerify.status}`);
  } else {
    fail('customer/verify-payment-ownership', 'no second customer in seed');
  }

  const banners = await api('GET', '/api/banners');
  banners.status === 200 && banners.body.success ? pass('customer/banners') : fail('customer/banners', banners.body.message);

  const nearby = await api('GET', '/api/kitchens/nearby?lat=22.643250&lng=75.583028', null, customerToken);
  if (nearby.body.success && nearby.body.count > 0 && nearby.body.data[0].photo) {
    pass('customer/nearby-kitchens-with-photos');
  } else {
    fail('customer/nearby-kitchens-with-photos', nearby.body.message || 'no kitchens/photos');
  }

  const place = await api(
    'POST',
    '/api/orders/place',
    {
      kitchenId: kitchen._id.toString(),
      items: [{ menuItemId: menuItem._id.toString(), qty: 1 }],
      paymentType: 'partialCod',
      deliveryAddress: {
        house: 'Test House',
        landmark: 'Test Landmark',
        label: 'Home',
        location: { type: 'Point', coordinates: [75.583028, 22.64325] },
      },
      schedule: { isScheduled: false },
    },
    customerToken
  );

  const orderDbId = place.body?.data?.order?._id || place.body?.data?._id;
  if (place.body.success && orderDbId) {
    pass('customer/place-order');
  } else {
    fail('customer/place-order', place.body.message || 'unknown');
    console.log(results.join('\n'));
    process.exit(1);
  }

  const accept = await api('PUT', `/api/orders/${orderDbId}/accept`, { deliveryMethod: 'rider' }, sellerToken);
  accept.body.success ? pass('seller/accept-order') : fail('seller/accept-order', accept.body.message);

  const doubleAccept = await api('PUT', `/api/orders/${orderDbId}/accept`, { deliveryMethod: 'rider' }, sellerToken);
  doubleAccept.body.success ? pass('seller/double-accept-idempotent') : fail('seller/double-accept-idempotent', doubleAccept.body.message);

  const rzpOrderId = accept.body?.data?.razorpayOrderId || accept.body?.data?.order?.razorpayOrderId;
  if (rzpOrderId) {
    const pay = await api(
      'POST',
      '/api/orders/verify',
      {
        orderId: orderDbId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: 'pay_mock_test',
        razorpay_signature: 'mock_signature',
      },
      customerToken
    );
    pay.body.success ? pass('customer/verify-payment-mock') : fail('customer/verify-payment-mock', pay.body.message);
  }

  const preparing = await api('PUT', `/api/orders/${orderDbId}/status`, { status: 'preparing' }, sellerToken);
  preparing.body.success ? pass('seller/status-preparing') : fail('seller/status-preparing', preparing.body.message);

  const rejectAfterPay = await api('PUT', `/api/orders/${orderDbId}/reject`, { reason: 'test' }, sellerToken);
  rejectAfterPay.status === 400 ? pass('seller/reject-after-pay-blocked') : fail('seller/reject-after-pay-blocked', `status ${rejectAfterPay.status}`);

  const rider = await Rider.findOne({ accountStatus: 'active' });
  if (rider) {
    const riderToken = jwt.sign({ id: rider.userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const acceptRide = await api('POST', `/api/riders/orders/${orderDbId}/accept`, {}, riderToken);
    acceptRide.body.success ? pass('rider/accept-order') : fail('rider/accept-order', acceptRide.body.message);
  } else {
    fail('rider/setup', 'no active rider in database');
  }

  const ready = await api('PUT', `/api/orders/${orderDbId}/status`, { status: 'ready' }, sellerToken);
  ready.body.success ? pass('seller/status-ready') : fail('seller/status-ready', ready.body.message);

  if (rider) {
    const riderToken = jwt.sign({ id: rider.userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const pickup = await api('PUT', `/api/riders/orders/${orderDbId}/pickup`, { otp: '1234' }, riderToken);
    pickup.body.success ? pass('rider/pickup-otp') : fail('rider/pickup-otp', pickup.body.message);

    const orderDoc = await Order.findById(orderDbId);
    const dropOtp = orderDoc?.dropOtp || '1234';
    const drop = await api('PUT', `/api/riders/orders/${orderDbId}/drop`, { otp: dropOtp }, riderToken);
    drop.body.success ? pass('rider/drop-otp') : fail('rider/drop-otp', drop.body.message);
  }

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL script:', err.message);
  process.exit(1);
});
