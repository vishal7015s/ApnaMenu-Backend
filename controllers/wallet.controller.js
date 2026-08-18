// ====================================
// Wallet & Digital Ledger Controller
// ====================================

const mongoose = require('mongoose');
const { MIN_WITHDRAWAL } = require('../utils/validation');
const Wallet = require('../models/Wallet');
const Order = require('../models/Order');
const Kitchen = require('../models/Kitchen');
const Rider = require('../models/Rider');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const { sendTelegramAlert } = require('../services/telegram.service');
const WalletDeposit = require('../models/WalletDeposit');
const walletCache = require('../services/walletCache.service');
const { getDelivererFeeEarning } = require('../utils/deliveryPricing');
const { getPartialCodOnlinePercent } = require('../utils/orderConfig');
const Razorpay = require('razorpay');
const crypto = require('crypto');

let razorpayInstance = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_ID !== 'your_razorpay_key_id') {
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

/**
 * Helper: Find or create wallet for a user and role
 */
const getOrCreateWallet = async (userId, role) => {
  let wallet = await Wallet.findOne({ userId, role });
  if (!wallet) {
    try {
      wallet = await Wallet.create({ userId, role, balance: 0, totalEarned: 0 });
    } catch (err) {
      if (err.code === 11000) {
        // Race condition: another request just created it.
        wallet = await Wallet.findOne({ userId, role });
      } else {
        throw err;
      }
    }
  }
  return wallet;
};

async function hasPendingWithdrawalFor(userId, role) {
  if (role === 'kitchen') {
    const kitchen = await Kitchen.findOne({ ownerId: userId }).select('_id').lean();
    if (!kitchen) return false;
    return Boolean(await Withdrawal.exists({ kitchenId: kitchen._id, status: 'pending' }));
  }
  const rider = await Rider.findOne({ userId }).select('_id').lean();
  if (!rider) return false;
  return Boolean(await Withdrawal.exists({ riderId: rider._id, status: 'pending' }));
}

/**
 * @desc    Get current user's wallet balance
 * @route   GET /api/wallets/me
 */
const getMyWallet = async (req, res) => {
  try {
    const role = req.user.activeRole === 'kitchen' ? 'kitchen' : 'rider';
    const userId = req.user._id.toString();

    const cached = await walletCache.get(userId, role);
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    const wallet = await getOrCreateWallet(req.user._id, role);
    const payload = typeof wallet.toObject === 'function' ? wallet.toObject() : { ...wallet };
    payload.hasPendingWithdrawal = await hasPendingWithdrawalFor(req.user._id, role);
    await walletCache.set(userId, role, payload);

    res.json({
      success: true,
      data: payload,
    });
  } catch (error) {
    console.error('getMyWallet error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Insert settlement txn + $inc in one Mongo transaction.
 * Unique (orderId, type) makes retries idempotent. Returns false if already recorded.
 */
async function applyOrderCredit({
  walletId,
  kitchenId,
  orderId,
  type,
  amount,
  description,
  walletInc,
  riderDocId,
  riderInc,
}) {
  const session = await mongoose.startSession();
  try {
    let applied = false;
    await session.withTransaction(async () => {
      try {
        await Transaction.create([{
          walletId,
          kitchenId: kitchenId || null,
          orderId,
          type,
          amount,
          description,
        }], { session });
      } catch (err) {
        if (err.code === 11000) return;
        throw err;
      }
      if (walletId && walletInc) {
        await Wallet.findByIdAndUpdate(walletId, { $inc: walletInc }, { session });
      }
      if (riderDocId && riderInc) {
        await Rider.findByIdAndUpdate(riderDocId, { $inc: riderInc }, { session });
      }
      applied = true;
    });
    return applied;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * @desc    Reconcile ledger upon order delivery (The 4 Master Cases)
 * @param   {Object} order - Mongoose Order Document
 */
const reconcileOrderDelivery = async (orderInput) => {
  if (!orderInput) return;

  // Atomic lock: claim walletSettled = true atomically so duplicate concurrent calls fail cleanly
  const order = await Order.findOneAndUpdate(
    { _id: orderInput._id, walletSettled: { $ne: true } },
    { $set: { walletSettled: true } },
    { new: true }
  );

  if (!order) {
    console.log(`[LEDGER] Order ${orderInput.orderId || orderInput._id} already settled.`);
    return;
  }

  let credited = false;
  try {
    const kitchen = await Kitchen.findById(order.kitchenId);
    if (!kitchen) throw new Error('Kitchen not found for ledger reconciliation');

    const sellerWallet = await getOrCreateWallet(kitchen.ownerId, 'kitchen');
    let riderWallet = null;
    let rider = null;

    if (order.deliveryMethod === 'rider' && order.riderId) {
      rider = await Rider.findOne({ userId: order.riderId });
      riderWallet = await getOrCreateWallet(order.riderId, 'rider');
    }

    const itemTotal = order.itemTotal || 0;
    const deliveryFee = Number(order.deliveryFee) || 0;
    const platformFee = Number(order.platformFee) || 0;
    const delivererEarning = getDelivererFeeEarning(order);
    const isOnline = order.paymentType === 'online';
    const isPartialCod = order.paymentType === 'partialCod';
    const onlinePct = getPartialCodOnlinePercent() / 100;
    const cashAmount = order.cashAmount != null
      ? order.cashAmount
      : (isPartialCod ? Math.round(order.grandTotal * (1 - onlinePct)) : 0);

    const onlineAmount = order.onlineAmount != null
      ? order.onlineAmount
      : (isPartialCod ? ((order.grandTotal || 0) - cashAmount) : (order.grandTotal || 0));
    const isDoorOnline = order.doorPaymentVerified === true || order.doorPaymentMode === 'online';

    console.log(`[LEDGER RECONCILIATION] Order: ${order.orderId} | Method: ${order.deliveryMethod} | PayType: ${order.paymentType} | DoorMode: ${order.doorPaymentMode || 'cash'} | IsDoorOnline: ${isDoorOnline} | DelivererFee: ₹${delivererEarning}`);

    const creditSeller = async (amount, description, extraInc = {}) => {
      const applied = await applyOrderCredit({
        walletId: sellerWallet._id,
        kitchenId: kitchen._id,
        orderId: order._id,
        type: 'advance',
        amount,
        description,
        walletInc: {
          balance: amount,
          totalEarned: extraInc.totalEarned != null ? extraInc.totalEarned : amount,
          ...(extraInc.floatingCashHeld ? { floatingCashHeld: extraInc.floatingCashHeld } : {}),
        },
      });
      if (applied) credited = true;
    };

    const creditRider = async ({ amount, description, walletInc, riderInc }) => {
      if (!riderWallet) return;
      const applied = await applyOrderCredit({
        walletId: riderWallet._id,
        kitchenId: kitchen._id,
        orderId: order._id,
        type: 'cash',
        amount,
        description,
        walletInc,
        riderDocId: rider?._id,
        riderInc,
      });
      if (applied) credited = true;
    };

    // CASE 1: 100% Online + Self Delivery
    if (isOnline && order.deliveryMethod === 'self') {
      await creditSeller(itemTotal + delivererEarning, `Case 1: 100% Online Self Delivery (${order.orderId})`);
    }

    // CASE 2: 100% Online + Request a Rider
    else if (isOnline && order.deliveryMethod === 'rider') {
      await creditSeller(itemTotal, `Case 2: 100% Online Rider Delivery - Seller Share (${order.orderId})`);
      if (delivererEarning) {
        await creditRider({
          amount: delivererEarning,
          description: `Case 2: Rider delivery earning (${order.orderId})`,
          walletInc: { balance: delivererEarning, totalEarned: delivererEarning },
          riderInc: { totalEarnings: delivererEarning },
        });
      }
    }

    // CASE 3: Partial COD + Self Delivery
    else if (isPartialCod && order.deliveryMethod === 'self') {
      const totalRevenue = itemTotal + delivererEarning;
      if (isDoorOnline) {
        await creditSeller(totalRevenue, `Case 3 (Online Door): Partial COD Self Delivery (${order.orderId})`);
      } else {
        const netCredit = totalRevenue - cashAmount;
        await creditSeller(netCredit, `Case 3 (Cash Door): Net Credit for Self Delivery (${order.orderId})`, {
          totalEarned: totalRevenue,
          floatingCashHeld: cashAmount,
        });
      }
    }

    // CASE 4: Partial COD + Request a Rider
    else if (isPartialCod && order.deliveryMethod === 'rider') {
      await creditSeller(itemTotal, `Case 4: Partial COD Rider Delivery - Seller Share (${order.orderId})`);
      if (isDoorOnline) {
        await creditRider({
          amount: delivererEarning,
          description: `Case 4 (Online Door): Rider earning (${order.orderId})`,
          walletInc: { balance: delivererEarning, totalEarned: delivererEarning },
          riderInc: { totalEarnings: delivererEarning },
        });
      } else {
        await creditRider({
          amount: delivererEarning,
          description: `Case 4 (Cash Door): Rider earning (${order.orderId})`,
          walletInc: {
            floatingCashHeld: cashAmount,
            balance: -(cashAmount - delivererEarning),
            totalEarned: delivererEarning,
          },
          riderInc: { floatingCash: cashAmount, totalEarnings: delivererEarning },
        });
      }
    }

    console.log(`[LEDGER RECONCILIATION SUCCESS] Order ${order.orderId} reconciled.`);
    await walletCache.invalidate(kitchen.ownerId, 'kitchen');
    if (order.riderId) {
      await walletCache.invalidate(order.riderId, 'rider');
    }
  } catch (error) {
    console.error(`[LEDGER ERROR] Order ${order?.orderId}:`, error);
    // If a credit txn already landed, do NOT unlock — retry would double-pay.
    const alreadyCredited = credited || await Transaction.exists({
      orderId: order?._id,
      type: { $in: ['advance', 'cash'] },
    });
    if (alreadyCredited) {
      console.error(`[LEDGER] Order ${order?.orderId} has credits — leaving walletSettled=true for manual review`);
    } else {
      await Order.findByIdAndUpdate(order?._id, { walletSettled: false }).catch(() => null);
    }
  }
};

/**
 * @desc    Create a deposit order (Razorpay) + persist pending WalletDeposit
 * @route   POST /api/wallets/deposit/order
 */
const createDepositOrder = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum deposit is ₹100' });
    }

    if (!razorpayInstance) {
      return res.status(500).json({ success: false, message: 'Razorpay is not configured on the server' });
    }

    const role = req.user.activeRole === 'kitchen' ? 'kitchen' : 'rider';
    const paise = Math.round(amount * 100);
    const receipt = `dep_${req.user._id.toString().slice(-6)}_${Date.now().toString(36)}`;

    const order = await razorpayInstance.orders.create({
      amount: paise,
      currency: 'INR',
      receipt,
      notes: {
        userId: String(req.user._id),
        role,
        purpose: 'wallet_deposit',
      },
    });

    const deposit = await WalletDeposit.create({
      userId: req.user._id,
      role,
      amount: paise / 100,
      razorpayOrderId: order.id,
      status: 'pending',
      receipt,
    });

    res.json({
      success: true,
      data: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID,
        depositId: deposit._id,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Idempotent credit for a captured Razorpay wallet deposit.
 * Inserts unique Transaction FIRST, then increments balance — never double-credits.
 */
const creditCapturedDeposit = async ({
  razorpayOrderId,
  razorpayPaymentId,
  creditAmount,
  userId,
  role,
}) => {
  if (!razorpayOrderId || !razorpayPaymentId) {
    const err = new Error('Missing Razorpay payment references');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
    const err = new Error('Invalid deposit amount');
    err.statusCode = 400;
    throw err;
  }

  const existingTxn = await Transaction.findOne({ razorpayPaymentId }).lean();
  if (existingTxn) {
    const wallet = await getOrCreateWallet(userId, role);
    return { alreadyProcessed: true, wallet };
  }

  let deposit = await WalletDeposit.findOne({ razorpayOrderId });
  if (deposit && deposit.status === 'credited') {
    const wallet = await getOrCreateWallet(deposit.userId, deposit.role);
    return { alreadyProcessed: true, wallet };
  }

  const ownerId = deposit?.userId || userId;
  const ownerRole = deposit?.role || role;
  if (!ownerId || !ownerRole) {
    const err = new Error('Deposit record not found for this payment');
    err.statusCode = 404;
    throw err;
  }

  // Ownership check when called from client verify
  if (userId && String(deposit?.userId || ownerId) !== String(userId)) {
    const err = new Error('Deposit does not belong to this user');
    err.statusCode = 403;
    throw err;
  }

  const session = await mongoose.startSession();
  let wallet;
  let alreadyProcessed = false;

  try {
    await session.withTransaction(async () => {
      const walletDoc = await getOrCreateWallet(ownerId, ownerRole);

      try {
        await Transaction.create(
          [
            {
              kitchenId: null,
              orderId: null,
              type: 'deposit',
              amount: creditAmount,
              description: `Wallet Deposit (Ref: ${razorpayPaymentId})`,
              walletId: walletDoc._id,
              razorpayPaymentId,
            },
          ],
          { session }
        );
      } catch (txnErr) {
        if (txnErr.code === 11000) {
          alreadyProcessed = true;
          return;
        }
        throw txnErr;
      }

      wallet = await Wallet.findByIdAndUpdate(
        walletDoc._id,
        { $inc: { balance: creditAmount } },
        { new: true, session }
      );

      if (deposit) {
        await WalletDeposit.updateOne(
          { _id: deposit._id, status: { $ne: 'credited' } },
          {
            $set: {
              status: 'credited',
              razorpayPaymentId,
              amount: creditAmount,
            },
          },
          { session }
        );
      } else {
        await WalletDeposit.create(
          [
            {
              userId: ownerId,
              role: ownerRole,
              amount: creditAmount,
              razorpayOrderId,
              razorpayPaymentId,
              status: 'credited',
            },
          ],
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }

  if (alreadyProcessed || !wallet) {
    wallet = await getOrCreateWallet(ownerId, ownerRole);
    return { alreadyProcessed: true, wallet };
  }

  await walletCache.invalidate(ownerId, ownerRole);
  return { alreadyProcessed: false, wallet };
};

/**
 * @desc    Verify deposit and credit wallet (client callback after Razorpay)
 * @route   POST /api/wallets/deposit/verify
 */
const verifyDeposit = async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, depositId } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ success: false, message: 'Invalid payment details' });
    }

    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    hmac.update(razorpayOrderId + '|' + razorpayPaymentId);
    const expectedSignature = hmac.digest('hex');

    if (expectedSignature !== razorpaySignature) {
      return res.status(400).json({ success: false, message: 'Payment verification failed (Invalid signature)' });
    }

    if (!razorpayInstance) {
      return res.status(500).json({ success: false, message: 'Razorpay is not configured on the server' });
    }

    let payment;
    try {
      payment = await razorpayInstance.payments.fetch(razorpayPaymentId);
    } catch (fetchErr) {
      console.warn('[verifyDeposit] Razorpay fetch failed:', fetchErr.message);
      return res.status(502).json({
        success: false,
        message: 'Could not confirm payment with Razorpay. If money was deducted, it will auto-credit shortly.',
        retryable: true,
      });
    }

    if (!payment) {
      return res.status(400).json({ success: false, message: 'Payment not found at Razorpay' });
    }

    if (payment.order_id && payment.order_id !== razorpayOrderId) {
      return res.status(400).json({ success: false, message: 'Payment does not match this deposit order' });
    }

    const status = String(payment.status || '').toLowerCase();
    if (status !== 'captured') {
      return res.status(400).json({
        success: false,
        message: `Payment not captured yet (status: ${payment.status})`,
        retryable: true,
      });
    }

    const creditAmount = Number(payment.amount) / 100;
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid payment amount from Razorpay' });
    }

    const role = req.user.activeRole === 'kitchen' ? 'kitchen' : 'rider';

    // Prefer depositId ownership when provided
    if (depositId) {
      const dep = await WalletDeposit.findById(depositId).lean();
      if (!dep || String(dep.userId) !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'Invalid deposit reference' });
      }
      if (dep.razorpayOrderId !== razorpayOrderId) {
        return res.status(400).json({ success: false, message: 'Deposit order mismatch' });
      }
    }

    const result = await creditCapturedDeposit({
      razorpayOrderId,
      razorpayPaymentId,
      creditAmount,
      userId: req.user._id,
      role,
    });

    const io = req.app?.get?.('io');
    if (io && !result.alreadyProcessed) {
      if (role === 'rider') {
        io.to(`rider_${req.user._id}`).emit('wallet:updated');
      } else {
        const kitchen = await Kitchen.findOne({ ownerId: req.user._id }).select('_id').lean();
        if (kitchen) io.to(`kitchen_${kitchen._id}`).emit('wallet:updated');
      }
    }

    return res.json({
      success: true,
      message: result.alreadyProcessed ? 'Deposit already processed' : 'Deposit successful',
      data: result.wallet,
    });
  } catch (error) {
    if (error.code === 11000) {
      const role = req.user.activeRole === 'kitchen' ? 'kitchen' : 'rider';
      const wallet = await getOrCreateWallet(req.user._id, role);
      return res.json({ success: true, message: 'Deposit already processed', data: wallet });
    }
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Deposit verification failed',
      retryable: Boolean(error.retryable),
    });
  }
};
/**
 * @desc    Request a withdrawal (fully atomic)
 * @route   POST /api/wallet/withdraw
 */
const requestWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { amount, method, details } = req.body;
    const reqAmount = Number(amount);

    if (!Number.isFinite(reqAmount) || reqAmount < MIN_WITHDRAWAL) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal is ₹${MIN_WITHDRAWAL}` });
    }

    if (!method || !String(details || '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'A saved payment method is required for withdrawal',
      });
    }

    const role = req.user.activeRole === 'kitchen' ? 'kitchen' : 'rider';
    let createdWithdrawal;

    await session.withTransaction(async () => {
      // Atomically deduct balance — only succeeds if balance >= reqAmount
      const wallet = await Wallet.findOneAndUpdate(
        { userId: req.user._id, role, balance: { $gte: reqAmount } },
        { $inc: { balance: -reqAmount, totalWithdrawn: reqAmount } },
        { new: true, session }
      );

      if (!wallet) {
        const err = new Error('Insufficient online balance');
        err.statusCode = 400;
        throw err;
      }

      let riderDoc = null;
      let kitchenDoc = null;
      let riderId = null;
      let kitchenId = null;

      if (role === 'rider') {
        riderDoc = await Rider.findOne({ userId: req.user._id }).session(session);
        if (!riderDoc) {
          const err = new Error('Rider profile not found');
          err.statusCode = 404;
          throw err;
        }
        riderId = riderDoc._id;

        // Prevent concurrent pending withdrawal requests
        const existingPending = await Withdrawal.findOne({
          riderId,
          status: 'pending',
        }).session(session);

        if (existingPending) {
          const err = new Error('A withdrawal request is already pending. Please wait for it to be processed.');
          err.statusCode = 409;
          throw err;
        }

        // Take rider offline if balance falls below ₹500 threshold
        if (wallet.balance < 500 && riderDoc.isOnline) {
          riderDoc.isOnline = false;
          riderDoc.dutyStartedAt = null;
          await riderDoc.save({ session });
          const riderGeo = require('../services/riderGeoCache.service');
          await riderGeo.removeRider(req.user._id);
        }
      } else {
        kitchenDoc = await Kitchen.findOne({ ownerId: req.user._id }).session(session);
        if (!kitchenDoc) {
          const err = new Error('Kitchen profile not found');
          err.statusCode = 404;
          throw err;
        }
        kitchenId = kitchenDoc._id;

        const existingPending = await Withdrawal.findOne({
          kitchenId,
          status: 'pending',
        }).session(session);

        if (existingPending) {
          const err = new Error('A withdrawal request is already pending. Please wait for it to be processed.');
          err.statusCode = 409;
          throw err;
        }
      }

      let paymentMethodType = 'phonepe';
      if (method?.toLowerCase().includes('qr')) paymentMethodType = 'qrcode';
      else if (method?.toLowerCase().includes('upi')) paymentMethodType = 'upi';
      else if (method?.toLowerCase().includes('bank')) paymentMethodType = 'bank';

      const pm = kitchenDoc?.paymentMethods || riderDoc?.paymentMethods || {};
      const bankDetails = pm.bankDetails || {};

      let paymentDetails = {
        qrCodeImage: '',
        phonePeNumber: '',
        upiId: '',
        bankAccount: {
          accountHolderName: '',
          accountNumber: '',
          ifscCode: '',
        },
      };

      if (paymentMethodType === 'phonepe') {
        paymentDetails.phonePeNumber = pm.phonePe || '';
        if (!paymentDetails.phonePeNumber) {
          const err = new Error('No PhonePe/UPI saved on your profile. Add it before withdrawing.');
          err.statusCode = 400;
          throw err;
        }
      } else if (paymentMethodType === 'upi') {
        paymentDetails.upiId = pm.upiId || '';
        if (!paymentDetails.upiId) {
          const err = new Error('No UPI ID saved on your profile. Add it before withdrawing.');
          err.statusCode = 400;
          throw err;
        }
      } else if (paymentMethodType === 'bank') {
        paymentDetails.bankAccount = {
          accountHolderName: bankDetails.accountName || '',
          accountNumber: bankDetails.accountNumber || '',
          ifscCode: bankDetails.ifsc || '',
        };
        if (!paymentDetails.bankAccount.accountNumber || !paymentDetails.bankAccount.ifscCode) {
          const err = new Error('No bank account saved on your profile. Add it before withdrawing.');
          err.statusCode = 400;
          throw err;
        }
      } else if (paymentMethodType === 'qrcode') {
        paymentDetails.qrCodeImage = pm.qrCodeUrl || '';
        if (!paymentDetails.qrCodeImage) {
          const err = new Error('No QR code saved on your profile. Add it before withdrawing.');
          err.statusCode = 400;
          throw err;
        }
      }

      const resolvedUpi = paymentDetails.phonePeNumber || paymentDetails.upiId || '';

      // Create withdrawal and transaction in the same atomic operation
      const [wd] = await Withdrawal.create([{
        requesterType: role,
        riderId,
        kitchenId,
        amount: reqAmount,
        currentBalance: wallet.balance,
        paymentMethodType,
        paymentDetails,
        upiId: resolvedUpi,
        status: 'pending',
      }], { session });

      await Transaction.create([{
        walletId: wallet._id,
        kitchenId,
        type: 'withdrawal',
        amount: reqAmount,
        description: `Withdrawal via ${method || 'UPI/PhonePe'} (${resolvedUpi || 'saved method'})`,
      }], { session });

      createdWithdrawal = wd;
    });

    // Notify client + admin (outside transaction — non-critical)
    if (createdWithdrawal) {
      const io = req.app?.get?.('io');
      if (io) {
        io.emit('withdrawal:created', createdWithdrawal);
        if (role === 'kitchen' && createdWithdrawal.kitchenId) {
          io.to(`kitchen_${createdWithdrawal.kitchenId}`).emit('wallet:updated');
        } else if (role === 'rider') {
          io.to(`rider_${req.user._id}`).emit('wallet:updated');
          const riderCheck = await Rider.findOne({ userId: req.user._id }).lean();
          if (riderCheck && !riderCheck.isOnline) {
            io.to(`rider_${req.user._id}`).emit('rider:kicked_offline', {
              message: 'Your wallet balance dropped below ₹500 after your withdrawal request. You have been taken offline.',
            });
          }
        }
      }

      sendTelegramAlert(
        `💸 <b>New Withdrawal Request</b>\n` +
        `Type: ${createdWithdrawal.requesterType === 'kitchen' ? 'Seller' : 'Rider'}\n` +
        `Amount: ₹${reqAmount.toLocaleString('en-IN')}\n` +
        `Method: ${method || createdWithdrawal.paymentMethodType || '—'}\n` +
        `Phone: ${req.user.phone || '—'}\n` +
        `ID: ${createdWithdrawal._id}\n\n` +
        `Admin panel → Withdrawals`
      ).catch(() => {});
    }

    await walletCache.invalidate(req.user._id, role);

    return res.json({
      success: true,
      message: 'Withdrawal request submitted successfully',
      data: createdWithdrawal,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A withdrawal request is already pending. Please wait for it to be processed.',
      });
    }
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to submit withdrawal request',
    });
  } finally {
    await session.endSession();
  }
};

/**
 * @desc    Get filtered wallet transactions
 * @route   GET /api/wallet/transactions
 */
const getWalletTransactions = async (req, res) => {
  try {
    const role = req.user.activeRole === 'kitchen' ? 'kitchen' : 'rider';
    const wallet = await getOrCreateWallet(req.user._id, role);
    
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    const allowedTypes = role === 'rider' || req.query.type === 'wallet_only'
      ? ['deposit', 'withdrawal', 'withdrawal_request', 'withdrawal_success', 'withdrawal_rejected']
      : ['deposit', 'withdrawal', 'withdrawal_request', 'withdrawal_success', 'withdrawal_rejected'];

    const [transactions, total] = await Promise.all([
      Transaction.find({
        walletId: wallet._id,
        type: { $in: allowedTypes },
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments({
        walletId: wallet._id,
        type: { $in: allowedTypes },
      }),
    ]);

    res.json({
      success: true,
      data: transactions,
      pagination: { skip, limit, total, hasMore: skip + transactions.length < total },
    });
  } catch (error) {
    console.error('getWalletTransactions error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getOrCreateWallet,
  getMyWallet,
  reconcileOrderDelivery,
  createDepositOrder,
  verifyDeposit,
  creditCapturedDeposit,
  requestWithdrawal,
  getWalletTransactions,
};

