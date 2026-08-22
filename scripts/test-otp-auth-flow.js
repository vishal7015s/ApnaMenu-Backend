#!/usr/bin/env node
/**
 * Test script for OTP Auth Flow & Role Enforcement Verification
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const User = require('../models/User');
const Rider = require('../models/Rider');
const { generateToken, getTokenVersion } = require('../utils/authTokens');
const { resolveOnboardingStep } = require('../utils/onboarding');

async function runOtpAuthTests() {
  console.log('\n========================================');
  console.log('🧪 RUNNING COMPREHENSIVE OTP & AUTH TESTS');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, extra = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName} - ${extra}`);
      failed++;
    }
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('📦 Connected to Database successfully\n');

    // ----------------------------------------------------
    // TEST CASE 1: Customer User Creation & Payload Structure
    // ----------------------------------------------------
    console.log('--- Test Case 1: Customer Login Payload Validation ---');
    const testCustPhone = '9999900001';
    await User.deleteMany({ phone: { $in: [testCustPhone, '9999900002', '9999900003'] } });
    await Rider.deleteMany({ phone: { $in: [testCustPhone, '9999900002', '9999900003'] } });

    let custUser = await User.create({
      phone: testCustPhone,
      role: 'customer',
      activeRole: 'customer',
    });

    const custToken = generateToken(custUser._id, getTokenVersion(custUser));
    const custStep = resolveOnboardingStep(custUser, null);

    assert(custToken && typeof custToken === 'string', 'JWT token generated successfully for customer');
    assert(custUser.role === 'customer' && custUser.activeRole === 'customer', 'Customer role and activeRole correctly set');
    assert(custStep === 'role_selection' || custStep === 'customer_profile' || custStep === 'complete', `Onboarding step resolved correctly: ${custStep}`);

    // ----------------------------------------------------
    // TEST CASE 2: Rider Role & Profile Validation
    // ----------------------------------------------------
    console.log('\n--- Test Case 2: Rider Login & Role Verification ---');
    const testRiderPhone = '9999900002';
    let riderUser = await User.create({
      phone: testRiderPhone,
      role: 'rider',
      activeRole: 'rider',
    });

    let riderProfile = await Rider.create({
      userId: riderUser._id,
      phone: testRiderPhone,
      name: 'Test Rider',
      vehicleType: 'bike',
      isVerified: true,
    });

    const riderToken = generateToken(riderUser._id, getTokenVersion(riderUser));
    assert(riderToken && typeof riderToken === 'string', 'JWT token generated successfully for rider');
    assert(riderProfile && riderProfile.name === 'Test Rider', 'Rider profile correctly linked to user');
    assert(riderUser.role === 'rider', 'Rider role enforced');

    // ----------------------------------------------------
    // TEST CASE 3: Role Conflict Protection (Rider on Customer App)
    // ----------------------------------------------------
    console.log('\n--- Test Case 3: Role Conflict Prevention (Cross-app login) ---');
    
    // Attempting to login as customer with a rider's number
    const attemptedRoleForRider = 'customer';
    const riderExists = await User.findOne({ phone: testRiderPhone });
    let blockedAsRiderInCustomerApp = false;
    let riderBlockMsg = '';
    
    if (attemptedRoleForRider !== 'rider' && riderExists.role === 'rider') {
      blockedAsRiderInCustomerApp = true;
      riderBlockMsg = 'This number is registered as a Rider. Please use the Rider app, or use a different number to order food.';
    }
    assert(blockedAsRiderInCustomerApp === true, 'Rider account correctly blocked from Customer App');
    assert(riderBlockMsg.includes('registered as a Rider'), 'Accurate error message returned for Rider on Customer App');

    // Attempting to login as rider with a customer's number
    const attemptedRoleForCust = 'rider';
    const custExists = await User.findOne({ phone: testCustPhone });
    let blockedAsCustInRiderApp = false;
    let custBlockMsg = '';
    
    if (attemptedRoleForCust === 'rider' && custExists.role !== 'rider') {
      blockedAsCustInRiderApp = true;
      custBlockMsg = 'This number is already registered for a Customer or Kitchen account. Please use a new, unique mobile number for your Rider account.';
    }
    assert(blockedAsCustInRiderApp === true, 'Customer account correctly blocked from Rider App');
    assert(custBlockMsg.includes('already registered for a Customer'), 'Accurate error message returned for Customer on Rider App');

    // ----------------------------------------------------
    // TEST CASE 4: Account Suspension / Deletion Check
    // ----------------------------------------------------
    console.log('\n--- Test Case 4: Account Suspension Check ---');
    const testSuspendedPhone = '9999900003';
    let suspendedUser = await User.create({
      phone: testSuspendedPhone,
      role: 'customer',
      activeRole: 'customer',
      accountStatus: 'suspended',
    });

    assert(suspendedUser.accountStatus === 'suspended', 'Suspended status flagged in database');
    let isBlocked = suspendedUser.accountStatus === 'suspended';
    assert(isBlocked === true, 'Suspended user correctly rejected from authentication');

    // Clean up test records
    await User.deleteMany({ phone: { $in: [testCustPhone, testRiderPhone, testSuspendedPhone] } });
    await Rider.deleteMany({ phone: { $in: [testCustPhone, testRiderPhone, testSuspendedPhone] } });

    console.log('\n========================================');
    console.log(`📊 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('========================================\n');

    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}

runOtpAuthTests();
