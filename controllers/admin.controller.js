// ====================================
// Admin Controller — Full Implementation
// ====================================

const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Kitchen = require('../models/Kitchen');
const Rider = require('../models/Rider');
const Order = require('../models/Order');
const Withdrawal = require('../models/Withdrawal');
const Wallet = require('../models/Wallet');
const Warning = require('../models/Warning');
const Transaction = require('../models/Transaction');
const AccountDeletion = require('../models/AccountDeletion');
const adminCache = require('../services/adminCache.service');
const walletCache = require('../services/walletCache.service');
const { invalidateNearbyCachesForKitchen } = require('../services/cacheInvalidation.service');

// ─── Auth ────────────────────────────────────────────

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin._id, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      success: true,
      token,
      admin: {
        _id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getMe = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        _id: req.admin._id,
        name: req.admin.name,
        email: req.admin.email,
        role: req.admin.role,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Dashboard ───────────────────────────────────────

const getDashboardStats = async (req, res) => {
  try {
    const {
      verifiedSellerKitchenFilter,
      pendingAdminKitchenFilter,
    } = require('../utils/kitchenVisibility');

    // Always count pending live — cached stats go stale when new kitchens register
    // (register didn't always invalidate), so this field must stay accurate for admin.
    const freshPendingKitchens = await Kitchen.countDocuments(pendingAdminKitchenFilter());

    const cached = await adminCache.getDashboardStats();
    if (cached && typeof cached === 'object') {
      return res.status(200).json({
        success: true,
        data: { ...cached, pendingKitchens: freshPendingKitchens },
      });
    }

    const [totalUsers, totalKitchens, verifiedKitchens, totalRiders, totalOrders, pendingWithdrawals, pendingDeletions] = await Promise.all([
      User.countDocuments({ role: 'customer' }),
      Kitchen.countDocuments(),
      Kitchen.countDocuments(verifiedSellerKitchenFilter()),
      Rider.countDocuments(),
      Order.countDocuments(),
      Withdrawal.countDocuments({ status: 'pending' }),
      AccountDeletion.countDocuments({ status: 'Pending' }),
    ]);

    // Active counts
    const [activeUsers, activeKitchens, activeRiders, blockedUsers, blockedKitchens, blockedRiders] = await Promise.all([
      User.countDocuments({ accountStatus: 'active', role: 'customer' }),
      Kitchen.countDocuments({ accountStatus: 'active' }),
      Rider.countDocuments({ accountStatus: 'active' }),
      User.countDocuments({ accountStatus: 'suspended', role: 'customer' }),
      Kitchen.countDocuments({ accountStatus: 'suspended' }),
      Rider.countDocuments({ accountStatus: 'suspended' }),
    ]);

    // Today's orders
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayOrders = await Order.countDocuments({ createdAt: { $gte: todayStart } });

    // Total revenue (sum of all delivered orders)
    const revenueAgg = await Order.aggregate([
      { $match: { status: 'delivered' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]);
    const totalRevenue = revenueAgg.length > 0 ? revenueAgg[0].total : 0;

    // Online riders right now
    const onlineRiders = await Rider.countDocuments({ isOnline: true, accountStatus: 'active' });

    const stats = {
      totalUsers,
      totalKitchens,
      verifiedKitchens,
      totalRiders,
      totalOrders,
      todayOrders,
      totalRevenue,
      pendingWithdrawals,
      pendingKitchens: freshPendingKitchens,
      onlineRiders,
      activeUsers,
      activeKitchens,
      activeRiders,
      blockedUsers,
      blockedKitchens,
      blockedRiders,
      pendingDeletions,
    };

    await adminCache.setDashboardStats(stats);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getDashboardRevenue = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);

    const monthStart = new Date(now);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [todayRev, weekRev, monthRev] = await Promise.all([
      Order.aggregate([
        { $match: { status: 'delivered', createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: 'delivered', createdAt: { $gte: weekStart } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: 'delivered', createdAt: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: {
        today: { revenue: todayRev[0]?.total || 0, orders: todayRev[0]?.count || 0 },
        week: { revenue: weekRev[0]?.total || 0, orders: weekRev[0]?.count || 0 },
        month: { revenue: monthRev[0]?.total || 0, orders: monthRev[0]?.count || 0 },
      },
    });
  } catch (error) {
    console.error('Dashboard revenue error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Finance & Payouts ──────────────────────────────

const getPendingWithdrawals = async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ status: 'pending' })
      .populate('kitchenId', 'name ownerName upiId paymentMethods')
      .populate('riderId', 'name phone paymentMethods')
      .sort({ requestedAt: -1 });

    res.status(200).json({ success: true, data: withdrawals });
  } catch (error) {
    console.error('Get pending withdrawals error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const approveWithdrawal = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, notes } = req.body; // action = 'approve' or 'reject'

    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ success: false, message: 'Invalid action. Use approve or reject.' });
    }

    const nextStatus = action === 'approve' ? 'approved' : 'rejected';
    const update = {
      status: nextStatus,
      notes: notes || (action === 'approve' ? 'Approved by admin' : 'Rejected by admin'),
    };
    if (action === 'approve') {
      update.approvedBy = req.admin._id;
      update.settledAt = new Date();
    }

    // Claim the pending row atomically so approve + reject cannot both succeed.
    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: update },
      { new: true }
    );

    if (!withdrawal) {
      const exists = await Withdrawal.findById(id).select('_id status').lean();
      if (!exists) {
        return res.status(404).json({ success: false, message: 'Withdrawal not found' });
      }
      return res.status(400).json({ success: false, message: 'Withdrawal already processed' });
    }

    let wallet = null;
    let rDoc = null;
    let kDoc = null;
    let ownerUserId = null;
    let ownerRole = 'kitchen';

    if (withdrawal.requesterType === 'rider') {
      rDoc = await Rider.findById(withdrawal.riderId);
      if (rDoc?.userId) {
        ownerUserId = rDoc.userId;
        ownerRole = 'rider';
        wallet = await Wallet.findOne({ userId: rDoc.userId, role: 'rider' });
      }
    } else {
      kDoc = await Kitchen.findById(withdrawal.kitchenId);
      if (kDoc?.ownerId) {
        ownerUserId = kDoc.ownerId;
        ownerRole = 'kitchen';
        wallet = await Wallet.findOne({ userId: kDoc.ownerId, role: 'kitchen' });
      }
    }

    if (wallet) {
      const pendingTxn = await Transaction.findOne({
        walletId: wallet._id,
        type: 'withdrawal',
        amount: withdrawal.amount,
      }).sort({ createdAt: -1 });

      if (action === 'approve') {
        const desc = `Withdraw Success (Paid via ${
          withdrawal.paymentMethodType === 'qrcode'
            ? 'QR Code'
            : withdrawal.paymentMethodType === 'bank'
            ? 'Account Number'
            : 'PhonePe Number'
        })`;

        if (pendingTxn) {
          pendingTxn.type = 'withdrawal_success';
          pendingTxn.description = desc;
          await pendingTxn.save();
        } else {
          await Transaction.create({
            walletId: wallet._id,
            kitchenId: withdrawal.kitchenId || null,
            type: 'withdrawal_success',
            amount: withdrawal.amount,
            description: desc,
          });
        }
      } else {
        const updatedWallet = await Wallet.findByIdAndUpdate(
          wallet._id,
          { $inc: { balance: withdrawal.amount, totalWithdrawn: -withdrawal.amount } },
          { new: true }
        );
        if (updatedWallet && updatedWallet.totalWithdrawn < 0) {
          await Wallet.findByIdAndUpdate(wallet._id, { $set: { totalWithdrawn: 0 } });
        }

        if (pendingTxn) {
          pendingTxn.type = 'withdrawal_rejected';
          pendingTxn.description = `Withdrawal Rejected (Refunded) — ${pendingTxn.description}`;
          await pendingTxn.save();
        } else {
          await Transaction.create({
            walletId: wallet._id,
            kitchenId: withdrawal.kitchenId || null,
            type: 'withdrawal_rejected',
            amount: withdrawal.amount,
            description: 'Withdrawal Rejected (Refunded)',
          });
        }
      }
    }

    if (ownerUserId) {
      await walletCache.invalidate(ownerUserId, ownerRole);
    }

    const io = req.app.get('io');
    if (io) {
      if (withdrawal.requesterType === 'rider' && rDoc) {
        io.to(`rider_${rDoc.userId}`).emit('wallet:updated');
        if (action === 'approve') {
          io.to(`rider_${rDoc.userId}`).emit('notification:new', {
            title: 'Payout Successful 💸',
            message: `Your withdrawal of ₹${withdrawal.amount} has been processed.`,
          });
        }
      } else if (withdrawal.requesterType === 'kitchen' && kDoc) {
        io.to(`kitchen_${kDoc._id}`).emit('wallet:updated');
        if (action === 'approve') {
          io.to(`kitchen_${kDoc._id}`).emit('notification:new', {
            title: 'Payout Successful 💸',
            message: `Your withdrawal of ₹${withdrawal.amount} has been processed.`,
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      message: `Withdrawal ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
      data: withdrawal,
    });
  } catch (error) {
    console.error('Approve withdrawal error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getWithdrawalHistory = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = {};
    if (status && status !== 'all') query.status = status;
    else query.status = { $in: ['approved', 'rejected'] };

    const withdrawals = await Withdrawal.find(query)
      .populate('kitchenId', 'name ownerName upiId paymentMethods')
      .populate('riderId', 'name phone paymentMethods')
      .populate('approvedBy', 'name')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Withdrawal.countDocuments(query);

    res.status(200).json({ success: true, data: withdrawals, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get withdrawal history error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getTransactions = async (req, res) => {
  try {
    // Return recent orders as transaction log
    const { page = 1, limit = 30 } = req.query;
    const orders = await Order.find({ status: 'delivered' })
      .select('orderId totalAmount paymentMethod status createdAt customerId kitchenId')
      .populate('customerId', 'name phone')
      .populate('kitchenId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Order.countDocuments({ status: 'delivered' });
    res.status(200).json({ success: true, data: orders, total });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── User Management ─────────────────────────────────

const getUsers = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const query = { role: 'customer' };

    if (status && status !== 'all') query.accountStatus = status;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .select('name phone role accountStatus createdAt avatar onlineOrderCount')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await User.countDocuments(query);

    res.status(200).json({ success: true, data: users, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Get user's orders and warnings
    const [orders, warnings] = await Promise.all([
      Order.find({ customerId: user._id }).sort({ createdAt: -1 }).limit(20).select('orderId totalAmount status createdAt'),
      Warning.find({ targetId: user._id, targetType: 'user' }).sort({ issuedAt: -1 }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        user,
        orders,
        warnings,
      },
    });
  } catch (error) {
    console.error('Get user by id error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const warnUser = async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Warning message required' });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const warning = await Warning.create({
      targetId: user._id,
      targetModel: 'User',
      targetType: 'user',
      title: title || 'Admin Notice / Warning',
      message,
      issuedBy: req.admin._id,
    });

    // Create a Notification entry so the user sees it in-app
    const Notification = require('../models/Notification');
    const notif = await Notification.create({
      title: title || 'Admin Notice / Warning',
      message,
      targetRole: 'user',
      type: 'alert',
      recipientId: user._id,
    });

    // Emit real-time socket notification
    const io = req.app.get('io');
    if (io) {
      const { emitNotificationToTargets } = require('../utils/notificationBroadcast');
      await emitNotificationToTargets(io, notif);
    }

    // Send FCM push notification
    if (user.fcmToken) {
      try {
        const { sendPushNotification } = require('../config/firebase');
        await sendPushNotification(
          user.fcmToken,
          title || 'Admin Notice / Warning',
          message,
          {
            type: 'admin_notification',
            notificationId: String(notif._id),
            userId: String(user._id),
          }
        );
      } catch (pushErr) {
        console.error('User FCM push notification failed:', pushErr.message);
      }
    }

    res.status(200).json({
      success: true,
      message: `Warning sent to ${user.name || user.phone}`,
      data: warning,
    });
  } catch (error) {
    console.error('Warn user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const suspendUser = async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.accountStatus = 'suspended';
    user.suspendedAt = new Date();
    user.suspendReason = reason || 'Suspended by admin';
    await user.save();

    res.status(200).json({
      success: true,
      message: `Account blocked: ${user.name || user.phone}`,
      data: user,
    });
  } catch (error) {
    console.error('Suspend user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const unsuspendUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.accountStatus = 'active';
    user.suspendedAt = null;
    user.suspendReason = null;
    await user.save();

    res.status(200).json({
      success: true,
      message: `Account unblocked: ${user.name || user.phone}`,
      data: user,
    });
  } catch (error) {
    console.error('Unsuspend user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.accountStatus = 'deleted';
    await user.save();

    res.status(200).json({
      success: true,
      message: `User account deleted: ${user.name || user.phone}`,
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Kitchen Management ──────────────────────────────

const getKitchens = async (req, res) => {
  try {
    const { search, status, verification, page = 1, limit = 20 } = req.query;
    const {
      verifiedSellerKitchenFilter,
      pendingAdminKitchenFilter,
    } = require('../utils/kitchenVisibility');
    const query = {};

    if (status && status !== 'all') query.accountStatus = status;

    if (verification === 'approved') {
      // Only verified restaurants (include legacy without verificationStatus)
      Object.assign(query, verifiedSellerKitchenFilter());
    } else if (verification === 'pending') {
      // Match dashboard pending count (exclude soft-deleted)
      Object.assign(query, pendingAdminKitchenFilter());
    } else if (verification && verification !== 'all') {
      query.verificationStatus = verification;
    }

    if (search) {
      const searchOr = [
        { name: { $regex: search, $options: 'i' } },
        { ownerName: { $regex: search, $options: 'i' } },
      ];
      if (query.$or) {
        // Combine approval $or with search $or via $and
        query.$and = [
          { $or: query.$or },
          { $or: searchOr },
        ];
        delete query.$or;
      } else {
        query.$or = searchOr;
      }
    }

    const kitchens = await Kitchen.find(query)
      .select('name ownerName upiId accountStatus verificationStatus verifiedAt rejectionReason isOpen totalOrders totalEarnings avgRating createdAt pinCode')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Kitchen.countDocuments(query);

    res.status(200).json({ success: true, data: kitchens, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get kitchens error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getKitchenDetails = async (req, res) => {
  try {
    const kitchen = await Kitchen.findById(req.params.id);
    if (!kitchen) return res.status(404).json({ success: false, message: 'Kitchen not found' });

    const [orders, warnings, withdrawals] = await Promise.all([
      Order.find({ kitchenId: kitchen._id }).sort({ createdAt: -1 }).limit(20).select('orderId totalAmount status createdAt'),
      Warning.find({ targetId: kitchen._id, targetType: 'kitchen' }).sort({ issuedAt: -1 }),
      Withdrawal.find({ kitchenId: kitchen._id }).sort({ requestedAt: -1 }).limit(10),
    ]);

    res.status(200).json({
      success: true,
      data: { kitchen, orders, warnings, withdrawals },
    });
  } catch (error) {
    console.error('Get kitchen details error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const warnKitchen = async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Warning message required' });

    const kitchen = await Kitchen.findById(req.params.id);
    if (!kitchen) return res.status(404).json({ success: false, message: 'Kitchen not found' });

    const warning = await Warning.create({
      targetId: kitchen._id,
      targetModel: 'Kitchen',
      targetType: 'kitchen',
      title: title || 'Admin Notice / Warning',
      message,
      issuedBy: req.admin._id,
    });

    const Notification = require('../models/Notification');
    const notif = await Notification.create({
      title: title || 'Admin Notice / Warning',
      message,
      targetRole: 'kitchen',
      type: 'alert',
      recipientId: kitchen._id,
    });

    const io = req.app.get('io');
    if (io) {
      const { emitNotificationToTargets } = require('../utils/notificationBroadcast');
      await emitNotificationToTargets(io, notif);
    }

    res.status(200).json({
      success: true,
      message: `Warning sent to kitchen: ${kitchen.name}`,
      data: warning,
    });
  } catch (error) {
    console.error('Warn kitchen error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const suspendKitchen = async (req, res) => {
  try {
    const { reason } = req.body;
    const kitchen = await Kitchen.findById(req.params.id);
    if (!kitchen) return res.status(404).json({ success: false, message: 'Kitchen not found' });

    const blockReason = reason || 'Kitchen account blocked by admin';

    kitchen.accountStatus = 'suspended';
    kitchen.suspendedAt = new Date();
    kitchen.suspendReason = blockReason;
    kitchen.isOpen = false;
    kitchen.expoPushToken = null;
    await kitchen.save();

    await invalidateNearbyCachesForKitchen(kitchen, { logPrefix: '[admin/suspend]' });

    // Mirror rider block: suspend linked User, revoke JWTs, drop live sockets
    if (kitchen.ownerId) {
      const { bumpTokenVersion } = require('../utils/authTokens');
      const { clearAuthCache } = require('../middleware/auth');

      await User.findByIdAndUpdate(kitchen.ownerId, {
        accountStatus: 'suspended',
        suspendedAt: new Date(),
        suspendReason: blockReason,
        fcmToken: null,
      });
      await bumpTokenVersion(kitchen.ownerId);
      clearAuthCache(kitchen.ownerId);

      try {
        const io = req.app.get('io');
        if (io) {
          io.to(`kitchen_${kitchen._id}`).emit('account:suspended', { reason: blockReason });
          io.to(`user_${kitchen.ownerId}`).emit('account:suspended', { reason: blockReason });
          io.in(`kitchen_${kitchen._id}`).disconnectSockets(true);
          io.in(`user_${kitchen.ownerId}`).disconnectSockets(true);
        }
      } catch (_) {}
    }

    res.status(200).json({
      success: true,
      message: `Kitchen blocked: ${kitchen.name}`,
      data: kitchen,
    });
  } catch (error) {
    console.error('Suspend kitchen error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const unsuspendKitchen = async (req, res) => {
  try {
    const kitchen = await Kitchen.findById(req.params.id);
    if (!kitchen) return res.status(404).json({ success: false, message: 'Kitchen not found' });

    kitchen.accountStatus = 'active';
    kitchen.suspendedAt = null;
    kitchen.suspendReason = null;
    await kitchen.save();

    await invalidateNearbyCachesForKitchen(kitchen, { logPrefix: '[admin/unsuspend]' });

    // Also unblock the linked User account (seller app reads User.accountStatus)
    if (kitchen.ownerId) {
      const { clearAuthCache } = require('../middleware/auth');
      await User.findByIdAndUpdate(kitchen.ownerId, {
        accountStatus: 'active',
        suspendedAt: null,
        suspendReason: null,
      });
      clearAuthCache(kitchen.ownerId);
    }

    res.status(200).json({
      success: true,
      message: `Kitchen unblocked: ${kitchen.name}`,
      data: kitchen,
    });
  } catch (error) {
    console.error('Unsuspend kitchen error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const deleteKitchen = async (req, res) => {
  try {
    const kitchen = await Kitchen.findById(req.params.id);
    if (!kitchen) return res.status(404).json({ success: false, message: 'Kitchen not found' });

    kitchen.accountStatus = 'deleted';
    await kitchen.save();

    await invalidateNearbyCachesForKitchen(kitchen, { logPrefix: '[admin/delete]' });

    res.status(200).json({
      success: true,
      message: `Kitchen deleted: ${kitchen.name}`,
    });
  } catch (error) {
    console.error('Delete kitchen error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const notifyKitchenOwner = async (req, kitchen, { title, message }) => {
  const Notification = require('../models/Notification');
  const notif = await Notification.create({
    title,
    message,
    targetRole: 'kitchen',
    type: 'alert',
    recipientId: kitchen._id,
  });

  const io = req.app.get('io');
  if (io) {
    const { emitNotificationToTargets } = require('../utils/notificationBroadcast');
    await emitNotificationToTargets(io, notif);
  }

  if (kitchen.expoPushToken) {
    try {
      const { sendPushNotification } = require('../config/firebase');
      await sendPushNotification(kitchen.expoPushToken, title, message, {
        type: 'kitchen_verification',
        kitchenId: String(kitchen._id),
        notificationId: String(notif._id),
      });
    } catch (pushErr) {
      console.error('Kitchen owner push notification failed:', pushErr.message);
    }
  }
};

const approveKitchen = async (req, res) => {
  try {
    const kitchen = await Kitchen.findById(req.params.id);
    if (!kitchen) return res.status(404).json({ success: false, message: 'Kitchen not found' });

    kitchen.verificationStatus = 'approved';
    kitchen.verifiedAt = new Date();
    kitchen.rejectionReason = null;
    await kitchen.save();

    await invalidateNearbyCachesForKitchen(kitchen, { logPrefix: '[admin/approve]' });
    await adminCache.invalidateDashboardStats();

    await notifyKitchenOwner(req, kitchen, {
      title: 'Restaurant Approved!',
      message: 'Your restaurant was approved by admin. You can now open your restaurant and accept orders.',
    });

    res.status(200).json({
      success: true,
      message: `Kitchen verified: ${kitchen.name}`,
      data: kitchen,
    });
  } catch (error) {
    console.error('Approve kitchen error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const rejectKitchen = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    }
    const kitchen = await Kitchen.findById(req.params.id);
    if (!kitchen) return res.status(404).json({ success: false, message: 'Kitchen not found' });

    const rejectionReason = String(reason).trim();

    kitchen.verificationStatus = 'rejected';
    kitchen.rejectionReason = rejectionReason;
    kitchen.isOpen = false;
    await kitchen.save();

    await invalidateNearbyCachesForKitchen(kitchen, { logPrefix: '[admin/reject]' });
    await adminCache.invalidateDashboardStats();

    await notifyKitchenOwner(req, kitchen, {
      title: 'Restaurant Verification Rejected',
      message: rejectionReason,
    });

    res.status(200).json({
      success: true,
      message: `Kitchen verification rejected: ${kitchen.name}`,
      data: kitchen,
    });
  } catch (error) {
    console.error('Reject kitchen error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Rider Management ────────────────────────────────

const getRiders = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const query = {};

    if (status && status !== 'all') query.accountStatus = status;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { vehicleNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const riders = await Rider.find(query)
      .select('name phone vehicleName vehicleNumber isOnline accountStatus totalEarnings floatingCash createdAt pinCode')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Rider.countDocuments(query);

    res.status(200).json({ success: true, data: riders, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get riders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getRiderById = async (req, res) => {
  try {
    const rider = await Rider.findById(req.params.id);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    // Get rider's wallet and withdrawal history
    const [wallet, withdrawals] = await Promise.all([
      Wallet.findOne({ userId: rider.userId, role: 'rider' }),
      Withdrawal.find({ riderId: rider._id }).sort({ requestedAt: -1 }).limit(10),
    ]);

    res.status(200).json({
      success: true,
      data: { rider, wallet, withdrawals },
    });
  } catch (error) {
    console.error('Get rider by id error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const warnRider = async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Warning message required' });

    const rider = await Rider.findById(req.params.id);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    // Store warning using User target (rider's userId)
    const warning = await Warning.create({
      targetId: rider._id,
      targetModel: 'User',
      targetType: 'user',
      title: title || 'Admin Notice / Warning',
      message,
      issuedBy: req.admin._id,
    });

    const Notification = require('../models/Notification');
    const notif = await Notification.create({
      title: title || 'Admin Notice / Warning',
      message,
      targetRole: 'rider',
      type: 'alert',
      recipientId: rider._id,
    });

    const io = req.app.get('io');
    if (io) {
      const { emitNotificationToTargets } = require('../utils/notificationBroadcast');
      await emitNotificationToTargets(io, notif);
    }

    res.status(200).json({
      success: true,
      message: `Warning sent to rider: ${rider.name}`,
      data: warning,
    });
  } catch (error) {
    console.error('Warn rider error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const suspendRider = async (req, res) => {
  try {
    const { reason } = req.body;
    const rider = await Rider.findById(req.params.id);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    rider.accountStatus = 'suspended';
    rider.isOnline = false;
    rider.expoPushToken = null;
    await rider.save();

    const riderGeo = require('../services/riderGeoCache.service');
    await riderGeo.removeRider(rider.userId);

    // Also suspend the linked User account + revoke all JWTs immediately
    if (rider.userId) {
      const { bumpTokenVersion } = require('../utils/authTokens');
      const { clearAuthCache } = require('../middleware/auth');

      await User.findByIdAndUpdate(rider.userId, {
        accountStatus: 'suspended',
        suspendedAt: new Date(),
        suspendReason: reason || 'Rider account blocked by admin',
        fcmToken: null,
      });
      await bumpTokenVersion(rider.userId);
      clearAuthCache(rider.userId);

      // Kick any live sockets off this rider immediately
      try {
        const io = req.app.get('io');
        if (io) {
          io.in(`rider_${rider.userId}`).disconnectSockets(true);
          io.in(`user_${rider.userId}`).disconnectSockets(true);
        }
      } catch (_) {}
    }

    res.status(200).json({
      success: true,
      message: `Rider blocked: ${rider.name}`,
      data: rider,
    });
  } catch (error) {
    console.error('Suspend rider error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const unsuspendRider = async (req, res) => {
  try {
    const rider = await Rider.findById(req.params.id);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    rider.accountStatus = 'active';
    await rider.save();

    // Also unblock the linked User account
    if (rider.userId) {
      const { clearAuthCache } = require('../middleware/auth');
      await User.findByIdAndUpdate(rider.userId, {
        accountStatus: 'active',
        suspendedAt: null,
        suspendReason: null,
      });
      clearAuthCache(rider.userId);
    }

    res.status(200).json({
      success: true,
      message: `Rider unblocked: ${rider.name}`,
      data: rider,
    });
  } catch (error) {
    console.error('Unsuspend rider error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Order Management ────────────────────────────────

const getOrders = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const query = {};

    if (status && status !== 'all') query.status = status;
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
      ];
    }

    const orders = await Order.find(query)
      .populate('customerId', 'name phone')
      .populate('kitchenId', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Order.countDocuments(query);

    res.status(200).json({ success: true, data: orders, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const forceCancelOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order.status = 'cancelled';
    await order.save();

    res.status(200).json({
      success: true,
      message: `Order ${order.orderId} force cancelled`,
      data: order,
    });
  } catch (error) {
    console.error('Force cancel order error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const refundOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order.status = 'refunded';
    await order.save();

    res.status(200).json({
      success: true,
      message: `Order ${order.orderId} marked as refunded`,
      data: order,
    });
  } catch (error) {
    console.error('Refund order error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getRiderDeposits = async (req, res) => {
  try {
    const deposits = await Transaction.find({ type: 'deposit' })
      .populate({
        path: 'walletId',
        populate: { path: 'userId', select: 'name phone email role' }
      })
      .sort({ createdAt: -1 });

    const formatted = deposits.map(tx => {
      const user = tx.walletId?.userId || {};
      return {
        _id: tx._id,
        amount: tx.amount,
        description: tx.description,
        createdAt: tx.createdAt,
        name: user.name || 'Rider',
        phone: user.phone || 'N/A',
        role: user.role || 'rider'
      };
    });

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error('getRiderDeposits error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Account Deletion Management ────────────────────────────────

const getDeletionRequests = async (req, res) => {
  try {
    const { status = 'Pending', page = 1, limit = 20 } = req.query;
    const query = {};
    if (status && status !== 'all') query.status = status;

    const requests = await AccountDeletion.find(query)
      .populate('user', 'name phone email role')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await AccountDeletion.countDocuments(query);

    res.status(200).json({ success: true, data: requests, total, page: Number(page), limit: Number(limit) });
  } catch (error) {
    console.error('getDeletionRequests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const resolveDeletionRequest = async (req, res) => {
  try {
    const request = await AccountDeletion.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });

    const userId = request.user;
    
    // Import all related models
    const User = require('../models/User');
    const Wallet = require('../models/Wallet');
    const Kitchen = require('../models/Kitchen');
    const MenuItem = require('../models/MenuItem');
    const Rider = require('../models/Rider');

    // 1. Delete Kitchen & Menu Items if they are a seller
    const kitchen = await Kitchen.findOne({ ownerId: userId });
    let kitchenIdStr = null;
    if (kitchen) {
      kitchenIdStr = kitchen._id.toString();
      await MenuItem.deleteMany({ kitchenId: kitchen._id });
      await Kitchen.findByIdAndDelete(kitchen._id);
      console.log(`[Cascade Delete] Deleted Kitchen and Menu Items for user ${userId}`);
    }

    // 2. Delete Rider profile if they are a rider
    const deletedRider = await Rider.findOneAndDelete({ userId: userId });
    if (deletedRider) {
      console.log(`[Cascade Delete] Deleted Rider profile for user ${userId}`);
    }

    // 3. Delete Wallet
    const deletedWallet = await Wallet.findOneAndDelete({ userId: userId });
    if (deletedWallet) {
      console.log(`[Cascade Delete] Deleted Wallet for user ${userId}`);
    }

    // 4. Delete the User themselves
    const deletedUser = await User.findByIdAndDelete(userId);
    if (deletedUser) {
      console.log(`[Cascade Delete] User ${deletedUser.phone} permanently deleted from database.`);
    }

    // 5. Clear sessions and disconnect live sockets
    try {
      const { bumpTokenVersion } = require('../utils/authTokens');
      const { clearAuthCache } = require('../middleware/auth');
      await bumpTokenVersion(userId);
      clearAuthCache(userId);

      const io = req.app.get('io');
      if (io) {
        io.in(`user_${userId}`).emit('account:deleted');
        io.in(`rider_${userId}`).emit('account:deleted');
        if (kitchenIdStr) {
          io.in(`kitchen_${kitchenIdStr}`).emit('account:deleted');
        }
        
        setTimeout(() => {
          io.in(`user_${userId}`).disconnectSockets(true);
          io.in(`rider_${userId}`).disconnectSockets(true);
          if (kitchenIdStr) {
            io.in(`kitchen_${kitchenIdStr}`).disconnectSockets(true);
          }
        }, 500);
      }
      console.log(`[Cascade Delete] Cleared auth cache and disconnected sockets for user ${userId}`);
    } catch (err) {
      console.error('[Cascade Delete] Error clearing sessions:', err);
    }

    // Finally, mark the request as resolved
    request.status = 'Resolved';
    request.resolvedAt = new Date();
    await request.save();

    res.status(200).json({ success: true, message: 'Account and all related data (except financial records) deleted permanently.', data: request });
  } catch (error) {
    console.error('resolveDeletionRequest error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


module.exports = {
  login, getMe, getDashboardStats, getDashboardRevenue,
  getPendingWithdrawals, approveWithdrawal, getWithdrawalHistory, getTransactions, getRiderDeposits,
  getUsers, getUserById, warnUser, suspendUser, unsuspendUser, deleteUser,
  getKitchens, getKitchenDetails, warnKitchen, suspendKitchen, unsuspendKitchen, deleteKitchen,
  approveKitchen, rejectKitchen,
  getRiders, getRiderById, warnRider, suspendRider, unsuspendRider,
  getOrders, forceCancelOrder, refundOrder,
  getDeletionRequests, resolveDeletionRequest
};
