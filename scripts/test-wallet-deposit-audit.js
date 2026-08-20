const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

// Connect to MongoDB using the backend URI
const MONGODB_URI = 'mongodb://vishalshivhare7015_db_user:BCvhSK8ccz54oHFU@ac-y2e2ejd-shard-00-00.jse7byr.mongodb.net:27017,ac-y2e2ejd-shard-00-01.jse7byr.mongodb.net:27017,ac-y2e2ejd-shard-00-02.jse7byr.mongodb.net:27017/ApnaMenu?ssl=true&replicaSet=atlas-1y1mcj-shard-0&authSource=admin&appName=Cluster0';

const User = require('../../../../../../../Users/visha/Desktop/local/ApnaMenu/backend/models/User');
const Wallet = require('../../../../../../../Users/visha/Desktop/local/ApnaMenu/backend/models/Wallet');
const WalletDeposit = require('../../../../../../../Users/visha/Desktop/local/ApnaMenu/backend/models/WalletDeposit');
const Transaction = require('../../../../../../../Users/visha/Desktop/local/ApnaMenu/backend/models/Transaction');
const { creditCapturedDeposit, getOrCreateWallet } = require('../../../../../../../Users/visha/Desktop/local/ApnaMenu/backend/controllers/wallet.controller');

async function runTests() {
  console.log('====================================================');
  console.log('  RIDER WALLET DEPOSIT & WEBHOOK PRODUCTION AUDIT   ');
  console.log('====================================================\n');

  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  // 1. Find or create a test rider user
  let testUser = await User.findOne({ phone: '9999999999' });
  if (!testUser) {
    testUser = await User.create({
      phone: '9999999999',
      roles: ['rider'],
      activeRole: 'rider',
      name: 'Test Rider Automated',
    });
  }

  // Reset test wallet
  await Wallet.deleteMany({ userId: testUser._id });
  await WalletDeposit.deleteMany({ userId: testUser._id });
  const initialWallet = await getOrCreateWallet(testUser._id, 'rider');
  console.log(`👤 Test Rider: ${testUser.name} (${testUser.phone})`);
  console.log(`💰 Starting Wallet Balance: ₹${initialWallet.balance}\n`);

  let allPassed = true;

  // ---------------------------------------------------------
  // TEST 1: The Exact Scenario (Net Disconnected / App Killed)
  // ---------------------------------------------------------
  console.log('--- TEST 1: USER PAYS ON RAZORPAY -> NET CLOSES -> WEBHOOK HANDLES DEPOSIT ---');
  const rzpOrderId1 = `order_test_netloss_${Date.now()}`;
  const rzpPaymentId1 = `pay_test_netloss_${Date.now()}`;
  const depositAmount1 = 500;

  // Step 1a: Rider initiated deposit (order created with status 'pending')
  await WalletDeposit.create({
    userId: testUser._id,
    role: 'rider',
    amount: depositAmount1,
    razorpayOrderId: rzpOrderId1,
    status: 'pending',
  });
  console.log(`  [1a] Deposit created on backend with status: 'pending' (₹${depositAmount1})`);
  console.log(`  [1b] Rider completes payment on Razorpay popup.`);
  console.log(`  [1c] ⚠️ SIMULATING EVENT: Rider app killed / Internet disconnected immediately!`);
  console.log(`       Mobile app did NOT call /verify endpoint.`);

  // Step 1b: Razorpay Webhook fires to backend
  console.log(`  [1d] 🌐 Razorpay Webhook arrives: payment.captured event`);
  const webhookResult = await creditCapturedDeposit({
    razorpayOrderId: rzpOrderId1,
    razorpayPaymentId: rzpPaymentId1,
    creditAmount: depositAmount1,
    userId: testUser._id,
    role: 'rider',
  });

  const walletAfterWebhook = await Wallet.findOne({ userId: testUser._id, role: 'rider' });
  const depositDoc1 = await WalletDeposit.findOne({ razorpayOrderId: rzpOrderId1 });

  console.log(`  [1e] Result: alreadyProcessed=${webhookResult.alreadyProcessed}`);
  console.log(`  [1f] Deposit Status in DB: '${depositDoc1.status}'`);
  console.log(`  [1g] New Wallet Balance: ₹${walletAfterWebhook.balance}`);

  if (walletAfterWebhook.balance === 500 && depositDoc1.status === 'credited' && !webhookResult.alreadyProcessed) {
    console.log('  ✅ TEST 1 PASSED: Webhook successfully credited ₹500 even when phone was offline!\n');
  } else {
    console.error('  ❌ TEST 1 FAILED!');
    allPassed = false;
  }

  // Step 1c: Rider comes back online later, app re-sends verify (late retry)
  console.log('  [1h] Rider opens app after internet returns -> App re-sends late verify request');
  const lateVerifyResult = await creditCapturedDeposit({
    razorpayOrderId: rzpOrderId1,
    razorpayPaymentId: rzpPaymentId1,
    creditAmount: depositAmount1,
    userId: testUser._id,
    role: 'rider',
  });
  const walletAfterLateVerify = await Wallet.findOne({ userId: testUser._id, role: 'rider' });
  console.log(`  [1i] Late verify alreadyProcessed=${lateVerifyResult.alreadyProcessed} | Balance: ₹${walletAfterLateVerify.balance}`);
  if (lateVerifyResult.alreadyProcessed === true && walletAfterLateVerify.balance === 500) {
    console.log('  ✅ TEST 1 (LATE RETRY) PASSED: Zero extra credit added on late retry!\n');
  } else {
    console.error('  ❌ TEST 1 (LATE RETRY) FAILED: Balance changed on retry!');
    allPassed = false;
  }

  // ---------------------------------------------------------
  // TEST 2: Brutal 10-Thread Concurrent Race Condition
  // ---------------------------------------------------------
  console.log('--- TEST 2: 10 PARALLEL CONCURRENT CALLS (5 WEBHOOKS + 5 CLIENT VERIFIES) ---');
  const rzpOrderId2 = `order_test_race_${Date.now()}`;
  const rzpPaymentId2 = `pay_test_race_${Date.now()}`;
  const depositAmount2 = 500;

  await WalletDeposit.create({
    userId: testUser._id,
    role: 'rider',
    amount: depositAmount2,
    razorpayOrderId: rzpOrderId2,
    status: 'pending',
  });

  const startBalance = walletAfterLateVerify.balance;
  console.log(`  Firing 10 concurrent requests simultaneously for order ${rzpOrderId2}...`);

  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(
      creditCapturedDeposit({
        razorpayOrderId: rzpOrderId2,
        razorpayPaymentId: rzpPaymentId2,
        creditAmount: depositAmount2,
        userId: testUser._id,
        role: 'rider',
      })
    );
  }

  const results = await Promise.all(promises);
  const successCount = results.filter(r => r.alreadyProcessed === false).length;
  const skippedCount = results.filter(r => r.alreadyProcessed === true).length;

  const walletAfterRace = await Wallet.findOne({ userId: testUser._id, role: 'rider' });
  const txnCount = await Transaction.countDocuments({ razorpayPaymentId: rzpPaymentId2 });

  console.log(`  Processed: ${successCount} won atomic lock, ${skippedCount} blocked by atomic lock.`);
  console.log(`  Wallet Balance: Before ₹${startBalance} -> After ₹${walletAfterRace.balance} (Expected ₹${startBalance + 500})`);
  console.log(`  Ledger Transactions recorded: ${txnCount} (Expected 1)`);

  if (successCount === 1 && skippedCount === 9 && walletAfterRace.balance === startBalance + 500 && txnCount === 1) {
    console.log('  ✅ TEST 2 PASSED: Concurrency test perfectly locked! Exactly 1 execution credited.\n');
  } else {
    console.error('  ❌ TEST 2 FAILED: Race condition leaked!');
    allPassed = false;
  }

  // Clean up test data
  await WalletDeposit.deleteMany({ userId: testUser._id });
  await Transaction.deleteMany({ razorpayPaymentId: { $in: [rzpPaymentId1, rzpPaymentId2] } });
  await Wallet.deleteMany({ userId: testUser._id });
  await User.deleteOne({ _id: testUser._id });

  console.log('====================================================');
  if (allPassed) {
    console.log('🎉 ALL PRODUCTION AUDIT & WEBHOOK TESTS PASSED 100%!');
  } else {
    console.log('❌ SOME TESTS FAILED');
  }
  console.log('====================================================');

  await mongoose.disconnect();
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
