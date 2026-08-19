// ====================================
// Kitchen Controller — Full Implementation
// ====================================

const Kitchen = require('../models/Kitchen');
const MenuItem = require('../models/MenuItem');
const Withdrawal = require('../models/Withdrawal');
const Order = require('../models/Order');
const User = require('../models/User');
const nearbyCache = require('../services/nearbyCache.service');
const { queryNearbyKitchens, DEFAULT_LIMIT, MAX_LIMIT } = require('../services/nearbyKitchens.service');
const { parsePagination } = require('../utils/parseCoords');
const { applyKitchenOpenState } = require('../services/kitchenDuty.service');
const { canRegisterKitchen } = require('../utils/accountRole');
const { validateIfsc, validateUpi, validateBankAccount, validateKitchenName, validateOwnerName } = require('../utils/validation');
const { VERIFICATION, isKitchenVerifiedForSeller } = require('../utils/kitchenVisibility');
const { sendTelegramAlert } = require('../services/telegram.service');
const { invalidateNearbyCachesForKitchen } = require('../services/cacheInvalidation.service');

/**
 * req.user may be a plain object served from the auth cache (not a Mongoose
 * document), which has no .save(). Fetch a real document when we need to persist.
 */
async function getSaveableUser(reqUser) {
  if (reqUser && typeof reqUser.save === 'function') return reqUser;
  return User.findById(reqUser._id || reqUser.id);
}

/**
 * PUT /api/kitchens/push-token
 * Updates FCM push token for the kitchen
 */
const updatePushToken = async (req, res) => {
  try {
    const { expoPushToken } = req.body;
    // expoPushToken === null is an explicit clear (e.g. on logout, so this device stops
    // receiving this kitchen's notifications); only a missing key is invalid.
    if (expoPushToken === undefined) {
      return res.status(400).json({ success: false, message: 'Push token is required' });
    }
    if (!req.user.kitchenId) {
      return res.status(400).json({ success: false, message: 'No kitchen associated with this account' });
    }

    let updateOp = expoPushToken
      ? { $addToSet: { expoPushTokens: expoPushToken } }
      : { $pull: { expoPushTokens: req.body.oldToken || expoPushToken } };

    if (!expoPushToken && !req.body.oldToken) {
       // If just setting null without specifying which token to remove, we might not want to clear ALL tokens.
       // The mobile app usually doesn't send oldToken, so if it sends null, we clear the array for safety or keep it as is.
       // Actually, to be safe, if they send null, let's clear the whole array (user logging out from all, or just clear the array).
       // A better approach is to require the exact token to remove. If none provided, we just return.
       updateOp = { $set: { expoPushTokens: [] } };
    }

    await Kitchen.findByIdAndUpdate(
      req.user.kitchenId,
      updateOp,
      { new: true }
    );

    res.status(200).json({ success: true, message: 'Token updated successfully' });
  } catch (error) {
    console.error('Update Push Token Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error updating push token' });
  }
};

/**
 * GET /api/kitchens/nearby?lat=&lng=&page=1&limit=10
 * Paginated kitchens within delivery radius (MongoDB $geoNear + geohash cache).
 */
const getNearbyKitchens = async (req, res) => {
  try {
    let { lat, lng } = req.query;

    if (!lat || !lng || lat === 'undefined' || lng === 'undefined' || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) {
      return res.status(400).json({
        success: false,
        message: 'Valid lat and lng query parameters are required.',
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const { page, limit } = parsePagination(req.query, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });

    const cached = await nearbyCache.get(latitude, longitude, { page, limit });
    if (cached) {
      return res.json(cached);
    }

    const { kitchens, pagination } = await queryNearbyKitchens(latitude, longitude, { page, limit });

    const payload = {
      success: true,
      count: kitchens.length,
      emptyState: kitchens.length === 0,
      data: {
        kitchens,
        pagination,
      },
    };

    await nearbyCache.set(latitude, longitude, payload, { page, limit });

    res.json(payload);
  } catch (error) {
    console.error('getNearbyKitchens error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/kitchens/register
 * Register a new kitchen (seller)
 */
const registerKitchen = async (req, res) => {
  try {
    const { name, ownerName, upiId, fssaiNumber, pinCode, latitude, longitude, photo } = req.body;

    const nameCheck = validateKitchenName(name);
    if (!nameCheck.ok) {
      return res.status(400).json({ success: false, message: nameCheck.message });
    }
    const ownerCheck = validateOwnerName(ownerName);
    if (!ownerCheck.ok) {
      return res.status(400).json({ success: false, message: ownerCheck.message });
    }
    const trimmedName = nameCheck.value;
    const trimmedOwner = ownerCheck.value;

    if (latitude == null || longitude == null) {
      return res.status(400).json({
        success: false,
        message: 'name, ownerName, latitude, and longitude are required.',
      });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid latitude or longitude.',
      });
    }

    // Idempotency: a slow/dropped network response (e.g. cover photo upload timing out)
    // can make the client believe registration failed even though the kitchen was
    // created on a previous attempt. Treat a retry for the same owner as success
    // instead of erroring, so the user isn't stuck after pressing "Next" again.
    const existingKitchen = await Kitchen.findOne({ ownerId: req.user._id });
    if (existingKitchen) {
      if (req.user.role !== 'kitchen') {
        const userDoc = await getSaveableUser(req.user);
        if (userDoc) {
          userDoc.role = 'kitchen';
          userDoc.activeRole = 'kitchen';
          userDoc.signupIntent = null;
          await userDoc.save();
        }
      }
      const { clearAuthCache } = require('../middleware/auth');
      clearAuthCache(req.user._id);

      return res.status(200).json({
        success: true,
        message: 'Kitchen registered successfully!',
        data: existingKitchen,
      });
    }

    const mayRegister = await canRegisterKitchen(req.user);
    if (!mayRegister) {
      return res.status(403).json({
        success: false,
        code: 'ROLE_CONFLICT_CUSTOMER',
        message:
          'This phone number is already registered as a customer. Use a different number to open a kitchen, or log in as a customer.',
      });
    }

    let photoUrl =
      photo ||
      'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500&auto=format&fit=crop&q=80';

    if (typeof photo === 'string' && photo.startsWith('data:image')) {
      const { uploadImage } = require('../config/cloudinary');
      const uploadRes = await uploadImage(photo, 'apnamenu/kitchens');
      photoUrl = uploadRes.url;
    } else if (typeof photo === 'string' && photo.startsWith('file://')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid photo format. Please re-select your banner image.',
      });
    }

    const kitchen = await Kitchen.create({
      ownerId: req.user._id,
      name: trimmedName,
      ownerName: trimmedOwner,
      upiId: upiId || '',
      fssaiNumber: fssaiNumber || '',
      pinCode: pinCode || '',
      photo: photoUrl,
      verificationStatus: VERIFICATION.PENDING,
      location: {
        type: 'Point',
        coordinates: [lng, lat],
      },
    });

    // Seller becomes kitchen-only (no dual customer+seller on same account)
    const userDoc = await getSaveableUser(req.user);
    if (userDoc) {
      if (userDoc.role === 'customer') {
        userDoc.role = 'kitchen';
        userDoc.activeRole = 'kitchen';
      }
      userDoc.signupIntent = null;
      await userDoc.save();
    }

    const { clearAuthCache } = require('../middleware/auth');
    clearAuthCache(req.user._id);

    sendTelegramAlert(
      `🏪 <b>New Kitchen — Pending Verification</b>\n` +
      `Name: ${trimmedName}\n` +
      `Owner: ${trimmedOwner}\n` +
      `Phone: ${req.user.phone || '—'}\n` +
      `FSSAI: ${fssaiNumber || '—'}\n` +
      `ID: ${kitchen._id}\n\n` +
      `Admin panel se verify karein.`
    ).catch(() => {});

    try {
      const adminCache = require('../services/adminCache.service');
      await adminCache.invalidateDashboardStats();
    } catch (cacheErr) {
      console.warn('[registerKitchen] dashboard stats invalidate failed:', cacheErr.message);
    }

    res.status(201).json({
      success: true,
      message: 'Kitchen registered successfully! Awaiting admin verification.',
      data: kitchen,
    });
  } catch (error) {
    console.error('registerKitchen error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/kitchens/toggle-status
 * Toggle kitchen open/close
 */
const toggleStatus = async (req, res) => {
  try {
    const kitchen = await Kitchen.findOne({ ownerId: req.user._id });
    if (!kitchen) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    const nextIsOpen = !kitchen.isOpen;

    // Opening: keep the same verification gates as before.
    if (nextIsOpen) {
      if (kitchen.verificationStatus === VERIFICATION.PENDING) {
        return res.status(403).json({
          success: false,
          message: 'Your kitchen is pending admin verification. You can go live after approval.',
        });
      }
      if (kitchen.verificationStatus === VERIFICATION.REJECTED) {
        return res.status(403).json({
          success: false,
          message: kitchen.rejectionReason
            ? `Kitchen verification rejected: ${kitchen.rejectionReason}`
            : 'Your kitchen verification was rejected. Contact admin for help.',
        });
      }
    }

    const io = req.app.get('io');
    // Single source of truth for open/close side effects (also used by 3-strike auto-offline).
    const { kitchen: updated } = await applyKitchenOpenState(kitchen, nextIsOpen, { io });

    res.json({
      success: true,
      message: `Kitchen is now ${updated.isOpen ? 'OPEN' : 'CLOSED'}`,
      data: { isOpen: updated.isOpen },
    });
  } catch (error) {
    console.error('toggleStatus error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/kitchens/dashboard
 * Kitchen owner dashboard — lite by default (profile + open status).
 * Pass ?periods=1 for today/week/month/year earnings aggregation (Profile screen).
 */
const getDashboard = async (req, res) => {
  try {
    const kitchen = await Kitchen.findOne({ ownerId: req.user._id });
    if (!kitchen) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    const wantPeriods =
      req.query.periods === '1' ||
      req.query.periods === 'true' ||
      req.query.full === '1';

    const base = {
      kitchen,
      lifetimeEarnings: kitchen.totalEarnings || 0,
      totalOrders: kitchen.totalOrders || 0,
      avgRating: kitchen.avgRating,
    };

    if (!isKitchenVerifiedForSeller(kitchen) || !wantPeriods) {
      return res.json({
        success: true,
        data: base,
      });
    }

    const Order = require('../models/Order');

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    const dayOfWeek = startOfWeek.getDay();
    const diff = startOfWeek.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    startOfWeek.setDate(diff);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const [aggResult] = await Order.aggregate([
      { $match: { kitchenId: kitchen._id, status: 'delivered' } },
      {
        $addFields: {
          earning: {
            $cond: [
              { $eq: ['$deliveryMethod', 'rider'] },
              { $ifNull: ['$itemTotal', 0] },
              { $add: [{ $ifNull: ['$itemTotal', 0] }, { $ifNull: ['$deliveryFee', 0] }] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          lifetimeEarnings: { $sum: '$earning' },
          totalOrders: { $sum: 1 },
          todayEarnings: {
            $sum: {
              $cond: [{ $gte: ['$createdAt', startOfDay] }, '$earning', 0],
            },
          },
          weekEarnings: {
            $sum: {
              $cond: [{ $gte: ['$createdAt', startOfWeek] }, '$earning', 0],
            },
          },
          monthEarnings: {
            $sum: {
              $cond: [{ $gte: ['$createdAt', startOfMonth] }, '$earning', 0],
            },
          },
          yearEarnings: {
            $sum: {
              $cond: [{ $gte: ['$createdAt', startOfYear] }, '$earning', 0],
            },
          },
        },
      },
    ]);

    const stats = aggResult || {
      lifetimeEarnings: kitchen.totalEarnings || 0,
      totalOrders: kitchen.totalOrders || 0,
      todayEarnings: 0,
      weekEarnings: 0,
      monthEarnings: 0,
      yearEarnings: 0,
    };

    res.json({
      success: true,
      data: {
        kitchen,
        todayEarnings: stats.todayEarnings,
        weekEarnings: stats.weekEarnings,
        monthEarnings: stats.monthEarnings,
        yearEarnings: stats.yearEarnings,
        lifetimeEarnings: stats.lifetimeEarnings,
        totalOrders: stats.totalOrders,
        avgRating: kitchen.avgRating,
      },
    });
  } catch (error) {
    console.error('getDashboard error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/kitchens/earnings
 */
const getEarnings = async (req, res) => {
  try {
    const kitchen = await Kitchen.findOne({ ownerId: req.user._id });
    if (!kitchen) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    res.json({
      success: true,
      data: {
        totalEarnings: kitchen.totalEarnings,
        totalOrders: kitchen.totalOrders,
      },
    });
  } catch (error) {
    console.error('getEarnings error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const getOrderEarning = (o) => {
  if (o.status !== 'delivered') return 0;
  return o.deliveryMethod === 'rider'
    ? (Number(o.itemTotal) || 0)
    : ((Number(o.itemTotal) || 0) + (Number(o.deliveryFee) || 0));
};

const buildDailyStatsFromOrders = (orders) => {
  const revenue = orders.reduce((sum, o) => sum + getOrderEarning(o), 0);
  const activeCount = orders.filter((o) => !['delivered', 'cancelled', 'autoCancelled'].includes(o.status)).length;
  const totalOrdersCount = orders.length;
  const cancelledCount = orders.filter((o) => ['cancelled', 'autoCancelled'].includes(o.status)).length;
  const deliveredCount = orders.filter((o) => o.status === 'delivered').length;

  let onlineRevenue = 0;
  let cashRevenue = 0;
  orders.forEach((o) => {
    if (o.status === 'delivered') {
      const earning = getOrderEarning(o);
      if (o.paymentType === 'cod') {
        cashRevenue += earning;
      } else if (o.paymentType === 'partialCod') {
        if (o.deliveryMethod === 'rider') {
          // Rider delivery: seller food earning is always settled via online wallet
          onlineRevenue += earning;
        } else {
          // Self delivery:
          if (o.doorPaymentMode === 'online') {
            // Door QR was paid online -> 100% online
            onlineRevenue += earning;
          } else {
            // Door payment was cash -> 50% online advance share, 50% cash share
            const onlineShare = Math.round(earning * 0.5);
            const cashShare = earning - onlineShare;
            onlineRevenue += onlineShare;
            cashRevenue += cashShare;
          }
        }
      } else if (o.paymentType === 'online' || o.doorPaymentMode === 'online') {
        onlineRevenue += earning;
      } else {
        onlineRevenue += earning;
      }
    }
  });

  return {
    revenue,
    activeCount,
    totalOrdersCount,
    cancelledCount,
    deliveredCount,
    onlineRevenue,
    cashRevenue,
  };
};

/**
 * GET /api/kitchens/stats?date=YYYY-MM-DD OR ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Kitchen daily stats for selected date or range
 */
const getDailyStats = async (req, res) => {
  try {
    const kitchen = await Kitchen.findOne({ ownerId: req.user._id });
    if (!kitchen) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    if (!isKitchenVerifiedForSeller(kitchen)) {
      return res.json({
        success: true,
        data: buildDailyStatsFromOrders([]),
      });
    }

    const { date, from, to } = req.query;
    let startOfDay;
    let endOfDay;

    if (from && to && typeof from === 'string' && typeof to === 'string') {
      const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
      const [toYear, toMonth, toDay] = to.split('-').map(Number);
      startOfDay = new Date(fromYear, fromMonth - 1, fromDay, 0, 0, 0, 0);
      endOfDay = new Date(toYear, toMonth - 1, toDay, 23, 59, 59, 999);
    } else if (date && typeof date === 'string' && date.includes('-')) {
      const [year, month, day] = date.split('-').map(Number);
      startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
      endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
    } else {
      const now = new Date();
      startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    }

    const orders = await Order.find({
      kitchenId: kitchen._id,
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).lean();

    res.json({
      success: true,
      data: buildDailyStatsFromOrders(orders),
    });
  } catch (error) {
    console.error('getDailyStats error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/kitchens/profile
 * Update Kitchen profile (paymentMethods, etc.)
 */
const updateProfile = async (req, res) => {
  try {
    const { paymentMethods, name, fssaiNumber, photo } = req.body;
    const kitchen = await Kitchen.findOne({ ownerId: req.user._id });
    if (!kitchen) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    const prevName = kitchen.name;
    const prevPhoto = kitchen.photo;

    if (name !== undefined) {
      const nameCheck = validateKitchenName(name);
      if (!nameCheck.ok) {
        return res.status(400).json({ success: false, message: nameCheck.message });
      }
      kitchen.name = nameCheck.value;
    }
    if (fssaiNumber !== undefined) kitchen.fssaiNumber = fssaiNumber;

    if (photo !== undefined) {
      if (typeof photo !== 'string') {
        return res.status(400).json({ success: false, message: 'Invalid photo payload' });
      }
      if (photo.startsWith('data:image')) {
        const { uploadImage } = require('../config/cloudinary');
        const uploadRes = await uploadImage(photo, 'apnamenu/kitchens');
        kitchen.photo = uploadRes.url;
      } else if (!photo.startsWith('file://') && photo.trim()) {
        kitchen.photo = photo.trim();
      }
    }

    if (paymentMethods) {
      if (!kitchen.paymentMethods) {
        kitchen.paymentMethods = {};
      }

      if (paymentMethods.phonePe !== undefined) {
        const phonePe = String(paymentMethods.phonePe || '').trim();
        if (phonePe && !/^[6-9]\d{9}$/.test(phonePe)) {
          return res.status(400).json({ success: false, message: 'Invalid PhonePe number' });
        }
        kitchen.paymentMethods.phonePe = phonePe;
      }
      if (paymentMethods.upiId !== undefined) {
        const upiRaw = String(paymentMethods.upiId || '').trim();
        if (upiRaw) {
          const upiCheck = validateUpi(upiRaw);
          if (!upiCheck.ok) {
            return res.status(400).json({ success: false, message: upiCheck.message });
          }
          kitchen.paymentMethods.upiId = upiCheck.value || upiRaw;
        } else {
          kitchen.paymentMethods.upiId = '';
        }
        kitchen.upiId = kitchen.paymentMethods.upiId; // maintain backward compatibility for root field
      }

      if (paymentMethods.bankDetails && typeof paymentMethods.bankDetails === 'object') {
        const { accountNumber, ifsc, accountName } = paymentMethods.bankDetails;
        const ac = accountNumber != null ? String(accountNumber).replace(/\s/g, '') : '';
        const ifscRaw = ifsc != null ? String(ifsc).trim() : '';
        const holder = accountName != null ? String(accountName).trim() : '';
        const hasAnyBank = Boolean(ac || ifscRaw || holder);

        // Empty bank payload must not wipe an existing saved account
        if (hasAnyBank) {
          if (!ac || !ifscRaw || !holder) {
            return res.status(400).json({
              success: false,
              message: 'Bank account requires account number, IFSC, and account holder name',
            });
          }
          const acCheck = validateBankAccount(ac);
          if (!acCheck.ok) return res.status(400).json({ success: false, message: acCheck.message });
          const ifscCheck = validateIfsc(ifscRaw);
          if (!ifscCheck.ok) return res.status(400).json({ success: false, message: ifscCheck.message });
          if (holder.length < 2 || holder.length > 60) {
            return res.status(400).json({ success: false, message: 'Invalid account holder name' });
          }
          kitchen.paymentMethods.bankDetails = {
            accountNumber: acCheck.value || ac,
            ifsc: ifscCheck.value || ifscRaw.toUpperCase(),
            accountName: holder,
          };
        }
      }

      if (typeof paymentMethods.qrCodeImage === 'string' && paymentMethods.qrCodeImage.startsWith('data:image')) {
        const { uploadImage } = require('../config/cloudinary');
        const uploadRes = await uploadImage(paymentMethods.qrCodeImage, 'apnamenu/payment-qrs');
        kitchen.paymentMethods.qrCodeUrl = uploadRes.url;
      } else if (paymentMethods.qrCodeUrl !== undefined) {
        const nextQr = typeof paymentMethods.qrCodeUrl === 'string' ? paymentMethods.qrCodeUrl.trim() : '';
        if (!nextQr.startsWith('file://')) {
          kitchen.paymentMethods.qrCodeUrl = nextQr;
        }
      }

      kitchen.markModified('paymentMethods');

      // Also sync user document's paymentDetails (used by withdraw UX)
      const User = require('../models/User');
      const preferredMethod =
        paymentMethods.preferredMethod ||
        (kitchen.paymentMethods.phonePe ? 'phonepe'
          : kitchen.paymentMethods.upiId ? 'upi'
          : kitchen.paymentMethods.qrCodeUrl ? 'qr'
          : kitchen.paymentMethods.bankDetails?.accountNumber ? 'bank'
          : undefined);

      const userPaymentSet = {
        'paymentDetails.phonepe': kitchen.paymentMethods.phonePe || '',
        'paymentDetails.upiId': kitchen.paymentMethods.upiId || '',
        'paymentDetails.acNumber': kitchen.paymentMethods.bankDetails?.accountNumber || '',
        'paymentDetails.ifsc': kitchen.paymentMethods.bankDetails?.ifsc || '',
        'paymentDetails.holderName': kitchen.paymentMethods.bankDetails?.accountName || '',
        'paymentDetails.qrImageUri': kitchen.paymentMethods.qrCodeUrl || '',
        'paymentDetails.qrUploaded': !!kitchen.paymentMethods.qrCodeUrl,
      };
      if (preferredMethod) {
        userPaymentSet['paymentDetails.method'] = preferredMethod;
      }

      await User.findByIdAndUpdate(req.user._id, { $set: userPaymentSet });
    }

    await kitchen.save();

    const cardFieldsChanged = kitchen.name !== prevName || kitchen.photo !== prevPhoto;
    if (cardFieldsChanged) {
      try {
        await invalidateNearbyCachesForKitchen(kitchen, { logPrefix: '[kitchen/profile]' });
      } catch (cacheErr) {
        console.warn('[kitchen/profile] cache invalidation failed:', cacheErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Kitchen profile updated successfully',
      data: kitchen
    });
  } catch (error) {
    console.error('updateProfile error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/kitchens/reviews
 * Fetch ratings/reviews for the kitchen
 */
const getReviews = async (req, res) => {
  try {
    const kitchen = await Kitchen.findOne({ ownerId: req.user._id });
    if (!kitchen) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    const Rating = require('../models/Rating');
    const reviews = await Rating.find({ kitchenId: kitchen._id })
      .populate('customerId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      data: reviews,
    });
  } catch (error) {
    console.error('getReviews error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  registerKitchen, getNearbyKitchens, toggleStatus,
  getDashboard, getEarnings, getDailyStats,
  updateProfile,
  getReviews,
  updatePushToken,
};

