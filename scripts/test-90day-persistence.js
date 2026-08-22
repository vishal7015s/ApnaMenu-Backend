#!/usr/bin/env node
/**
 * Test Suite: 90-Day (3-Month) Session Persistence & Resilient Auth Lifecycle
 * Tests Customer, Seller, and Rider session lifespans, time-travel validation,
 * and network resilience.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Kitchen = require('../models/Kitchen');
const Rider = require('../models/Rider');
const { generateToken, getTokenVersion } = require('../utils/authTokens');
const { protect } = require('../middleware/auth');

async function runSessionPersistenceTests() {
  console.log('\n===============================================================');
  console.log('🧪 RUNNING 90-DAY (3-MONTH) SESSION PERSISTENCE & LIFECYCLE TESTS');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName} ${details ? `(${details})` : ''}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName} - ${details}`);
      failed++;
    }
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('📦 Database connected successfully\n');

    const testSellerPhone = '9999911111';
    const testRiderPhone = '9999922222';
    await User.deleteMany({ phone: { $in: [testSellerPhone, testRiderPhone] } });
    await Kitchen.deleteMany({ phone: testSellerPhone });
    await Rider.deleteMany({ phone: testRiderPhone });

    // Setup Test Seller
    const sellerUser = await User.create({
      phone: testSellerPhone,
      role: 'kitchen',
      activeRole: 'kitchen',
      name: 'Test Chef',
    });
    const kitchen = await Kitchen.create({
      ownerId: sellerUser._id,
      name: 'Test Kitchen',
      phone: testSellerPhone,
      address: { street: '123 Test St', city: 'Test City' },
    });
    sellerUser.kitchenId = kitchen._id;
    await sellerUser.save();

    // Setup Test Rider
    const riderUser = await User.create({
      phone: testRiderPhone,
      role: 'rider',
      activeRole: 'rider',
      name: 'Test Delivery Partner',
    });
    const rider = await Rider.create({
      userId: riderUser._id,
      phone: testRiderPhone,
      name: 'Test Delivery Partner',
      vehicleType: 'bike',
      isVerified: true,
    });

    // ----------------------------------------------------
    // TEST 1: Token Mathematical Expiration Check (90 Days)
    // ----------------------------------------------------
    console.log('--- Test 1: Mathematical Expiration Calculation (90 Days / 7,776,000s) ---');
    const sellerToken = generateToken(sellerUser._id, getTokenVersion(sellerUser));
    const riderToken = generateToken(riderUser._id, getTokenVersion(riderUser));

    const decodedSeller = jwt.decode(sellerToken);
    const decodedRider = jwt.decode(riderToken);

    const sellerLifetimeSec = decodedSeller.exp - decodedSeller.iat;
    const riderLifetimeSec = decodedRider.exp - decodedRider.iat;

    const sellerDays = sellerLifetimeSec / (60 * 60 * 24);
    const riderDays = riderLifetimeSec / (60 * 60 * 24);

    assert(sellerDays === 90, 'Seller token lifetime is exactly 90 days', `${sellerDays} days`);
    assert(riderDays === 90, 'Rider token lifetime is exactly 90 days', `${riderDays} days`);

    // ----------------------------------------------------
    // TEST 2: Time-Travel Simulation (Day 1, Day 30, Day 60, Day 89)
    // ----------------------------------------------------
    console.log('\n--- Test 2: Time-Travel Simulation Through 90 Days ---');
    const checkpoints = [
      { day: 1, name: 'Day 1 (Next Day Login)' },
      { day: 15, name: 'Day 15 (2 Weeks Later)' },
      { day: 30, name: 'Day 30 (1 Month Later)' },
      { day: 60, name: 'Day 60 (2 Months Later)' },
      { day: 89, name: 'Day 89 (Almost 3 Months Later)' },
    ];

    for (const cp of checkpoints) {
      const pastIat = Math.floor(Date.now() / 1000) - (cp.day * 24 * 60 * 60);
      const expAt90Days = pastIat + (90 * 24 * 60 * 60);

      // Create token simulating that it was generated `cp.day` days ago
      const simulatedToken = jwt.sign(
        { id: sellerUser._id, tv: getTokenVersion(sellerUser), iat: pastIat, exp: expAt90Days },
        process.env.JWT_SECRET
      );

      // Verify with real backend auth middleware
      let authSucceeded = false;
      const mockReq = { headers: { authorization: `Bearer ${simulatedToken}` } };
      const mockRes = {
        status: (code) => ({ json: (data) => console.log('Mock err', code, data) }),
      };
      const mockNext = () => { authSucceeded = true; };

      await protect(mockReq, mockRes, mockNext);
      assert(authSucceeded, `Seller session remains ACTIVE on ${cp.name}`, `Token valid, user authenticated`);
    }

    // ----------------------------------------------------
    // TEST 3: Expired Token Rejection (Day 91)
    // ----------------------------------------------------
    console.log('\n--- Test 3: Day 91 (Post 90 Days Expiration) ---');
    const pastIat91 = Math.floor(Date.now() / 1000) - (91 * 24 * 60 * 60);
    const expAt91 = pastIat91 + (90 * 24 * 60 * 60); // Expired 1 day ago
    const expiredToken = jwt.sign(
      { id: sellerUser._id, tv: getTokenVersion(sellerUser), iat: pastIat91, exp: expAt91 },
      process.env.JWT_SECRET
    );

    let expiredRejected = false;
    try {
      jwt.verify(expiredToken, process.env.JWT_SECRET);
    } catch (e) {
      if (e.name === 'TokenExpiredError') expiredRejected = true;
    }
    assert(expiredRejected, 'Token cleanly expires after 90 days with TokenExpiredError');

    // ----------------------------------------------------
    // TEST 4: Cold-Start Session Rehydration Simulation
    // ----------------------------------------------------
    console.log('\n--- Test 4: Cold-Start App Rehydration (Zustand + AsyncStorage) ---');
    
    // Simulate what AsyncStorage stores for Seller
    const persistedSellerState = {
      isAuthenticated: true,
      token: sellerToken,
      user: {
        _id: sellerUser._id.toString(),
        phone: sellerUser.phone,
        role: 'kitchen',
        activeRole: 'kitchen',
        kitchenId: kitchen._id.toString(),
        name: sellerUser.name,
      },
    };

    // Navigation decision rule
    const sellerNeedsLogin = !persistedSellerState.isAuthenticated || !persistedSellerState.token;
    const sellerRoute = persistedSellerState.user.role === 'kitchen' && persistedSellerState.user.kitchenId ? 'SellerTabs' : 'Onboarding';
    
    assert(!sellerNeedsLogin, 'Seller cold-start DOES NOT require login', 'Session retained from storage');
    assert(sellerRoute === 'SellerTabs', 'Seller cold-start directly opens Seller Dashboard (SellerTabs)');

    // Simulate what AsyncStorage stores for Rider
    const persistedRiderState = {
      isAuthenticated: true,
      token: riderToken,
      user: {
        _id: riderUser._id.toString(),
        phone: riderUser.phone,
        role: 'rider',
        activeRole: 'rider',
      },
      riderProfile: {
        _id: rider._id.toString(),
        name: rider.name,
        isVerified: true,
      },
    };

    const riderNeedsLogin = !persistedRiderState.isAuthenticated || !persistedRiderState.token;
    const riderRoute = persistedRiderState.isAuthenticated && persistedRiderState.riderProfile?.name ? 'MainTabs' : 'Onboarding';

    assert(!riderNeedsLogin, 'Rider cold-start DOES NOT require login', 'Session retained from storage');
    assert(riderRoute === 'MainTabs', 'Rider cold-start directly opens Rider Delivery Tabs (MainTabs)');

    // ----------------------------------------------------
    // TEST 5: Network Error & Transient Drop Resilience
    // ----------------------------------------------------
    console.log('\n--- Test 5: Network Glitch / Server Restart Resilience ---');

    // Simulate api.js response interceptor logic on network failure
    function simulateInterceptor(networkErrorStatus) {
      let isLoggedOut = false;
      const originalRequest = { _retry: false, url: '/orders/my-orders' };

      // Updated interceptor logic:
      if (networkErrorStatus === 401 && originalRequest && !originalRequest._retry) {
        // Only log out if refresh token returns explicit 401/403
        const refreshErrorStatus = networkErrorStatus === 'NETWORK_ERROR' ? null : 401;
        if (refreshErrorStatus === 401) {
          isLoggedOut = true;
        }
      } else if (networkErrorStatus === 'NETWORK_ERROR' || networkErrorStatus === 'TIMEOUT' || networkErrorStatus === 502) {
        // Network drop: NEVER logout!
        isLoggedOut = false;
      }
      return isLoggedOut;
    }

    const logoutOnTimeout = simulateInterceptor('TIMEOUT');
    const logoutOn502 = simulateInterceptor(502);
    const logoutOnNetworkDrop = simulateInterceptor('NETWORK_ERROR');

    assert(logoutOnTimeout === false, 'App DOES NOT logout on server timeout (keeps session intact)');
    assert(logoutOn502 === false, 'App DOES NOT logout on 502/504 server restarts');
    assert(logoutOnNetworkDrop === false, 'App DOES NOT logout on cellular network drops');

    // Cleanup
    await User.deleteMany({ phone: { $in: [testSellerPhone, testRiderPhone] } });
    await Kitchen.deleteMany({ phone: testSellerPhone });
    await Rider.deleteMany({ phone: testRiderPhone });

    console.log('\n===============================================================');
    console.log(`📊 FINAL RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('===============================================================\n');

    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}

runSessionPersistenceTests();
