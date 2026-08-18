const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const Kitchen = require('../models/Kitchen');
const MenuItem = require('../models/MenuItem');
const { generateToken } = require('../utils/authTokens');
const http = require('http');

const KITCHEN_ID = '6a6f89dee75e1ed6f4fa9364';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: 'localhost',
        port: 5000,
        path: path,
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
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch(e) {
            resolve({ status: res.statusCode, body: raw });
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
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');

  // 1. Get Customer
  const customer = await User.findOne({ role: 'customer' });
  if (!customer) {
    console.error('No customer found!');
    process.exit(1);
  }
  const token = generateToken(customer);
  console.log('Using customer:', customer.name || customer.phone);

  // 2. Get Menu Items for Kitchen
  const items = await MenuItem.find({ kitchenId: KITCHEN_ID, inStock: true });
  if (items.length === 0) {
    console.error('No items found for this kitchen!');
    process.exit(1);
  }
  
  // 3. Create N Orders
  const numOrders = parseInt(process.argv[2], 10) || 1;
  for (let i = 1; i <= numOrders; i++) {
    const orderPayload = {
      kitchenId: KITCHEN_ID,
      items: [
        { menuItemId: items[0]._id.toString(), qty: 1 }
      ],
      deliveryAddress: {
        house: 'Test House ' + i,
        landmark: 'Test Landmark',
        label: 'home',
        location: { type: 'Point', coordinates: [75.583028, 22.643250] }
      },
      paymentType: 'partialCod' // 'partialCod' or 'online'
    };

    console.log(`Placing order ${i} of ${numOrders}...`);
    const res = await request('POST', '/api/orders/place', orderPayload, token);
    console.log(`Order ${i} result:`, res.status, res.body);
  }
  
  process.exit(0);
}

main().catch(console.error);
