// ====================================
// Rider Controller — Partner Operations
// ====================================

const mongoose = require('mongoose');
const Rider = require('../models/Rider');
const User = require('../models/User');
const Order = require('../models/Order');
const { reconcileOrderDelivery } = require('./wallet.controller');
const { isDevOtpAllowed } = require('../utils/validation');
const { getDelivererFeeEarning } = require('../utils/deliveryPricing');
const { recordDeliveredOrderStats } = require('../services/cacheInvalidation.service');

/**
 * @desc    Toggle Rider Online / Offline Duty
 * @route   PUT /api/riders/toggle-duty
 */
const toggleDuty = async (req, res) => {
  try {
    const { getOrCreateWallet } = require('./wallet.controller');
    const { isValidCoordinates, demoteGhostOnlineRiders } = require('../services/riderBroadcast.service');
    const { applyRiderOnlineState } = require('../services/riderDuty.service');
    const riderWallet = await getOrCreateWallet(req.user._id, 'rider');

    let rider = await Rider.findOne({ userId: req.user._id });
    
    // Determine target state (toggle if undefined)
    const targetIsOnline = req.body.isOnline !== undefined ? req.body.isOnline : (rider ? !rider.isOnline : true);

    // Check minimum deposit only when trying to go ONLINE
    if (targetIsOnline && riderWallet.balance < 500) {
      return res.status(403).json({
        success: false,
        message: 'A minimum wallet deposit of ₹500 is required to go on duty.',
        requiresDeposit: true,
      });
    }

    // Clear ghost "online" riders from previous logout/re-login sessions
    if (targetIsOnline) {
      await demoteGhostOnlineRiders().catch(() => null);
    }

    const phone = req.user.phone || req.user._doc?.phone;
    const name = (req.user.name && String(req.user.name).trim()) || 'Partner';

    // Optional GPS seed from client (last-known) so broadcast eligibility works immediately
    let seededLocation = null;
    if (targetIsOnline) {
      const lat = parseFloat(req.body.latitude);
      const lng = parseFloat(req.body.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && isValidCoordinates([lng, lat])) {
        seededLocation = {
          type: 'Point',
          coordinates: [lng, lat],
        };
      }
    }

    if (!rider) {
      if (!phone) {
        return res.status(400).json({
          success: false,
          message: 'Phone number is missing on your account. Please log in again.',
        });
      }
      const createPayload = {
        userId: req.user._id,
        name,
        phone,
        isOnline: false, // flip via applyRiderOnlineState so dutyStartedAt is set correctly
      };
      if (req.body.pinCode) {
        createPayload.pinCode = req.body.pinCode;
      }
      if (seededLocation) {
        createPayload.currentLocation = seededLocation;
        createPayload.lastLocationAt = new Date();
      }
      rider = await Rider.create(createPayload);
    } else {
      if (!rider.name) rider.name = name;
      if (!rider.phone) {
        if (!phone) {
          return res.status(400).json({
            success: false,
            message: 'Phone number is missing on your account. Please log in again.',
          });
        }
        rider.phone = phone;
      }
      if (req.body.pinCode && (!rider.pinCode || req.body.pinCode !== 'NA')) {
        rider.pinCode = req.body.pinCode;
      }
      if (seededLocation) {
        rider.currentLocation = seededLocation;
        rider.lastLocationAt = new Date();
      }
      await rider.save();
    }

    // Single source of truth: isOnline + dutyStartedAt + Redis GEO
    const { rider: updated } = await applyRiderOnlineState(rider, targetIsOnline);

    res.json({
      success: true,
      message: updated.isOnline ? 'You are now on duty.' : 'You are now off duty.',
      data: {
        isOnline: updated.isOnline,
        dutyStartedAt: updated.dutyStartedAt || null,
      },
    });
  } catch (error) {
    console.error('toggleDuty error:', error);
    // Duplicate key / validation → clearer client message
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Your rider profile already exists. Please try again.',
      });
    }
    res.status(500).json({
      success: false,
      message: 'Unable to update duty status right now. Please try again.',
    });
  }
};

/**
 * @desc    Update Rider GPS Location
 * @route   PUT /api/riders/location
 */
const updateLocation = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
      return res.status(400).json({ success: false, message: 'Latitude and longitude required.' });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const { isValidCoordinates } = require('../services/riderBroadcast.service');
    if (!isValidCoordinates([lng, lat])) {
      return res.status(400).json({ success: false, message: 'Invalid GPS coordinates.' });
    }

    const now = new Date();
    const rider = await Rider.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: {
          currentLocation: {
            type: 'Point',
            coordinates: [lng, lat],
          },
          lastLocationAt: now,
        },
      },
      { new: true }
    );

    if (!rider) {
      return res.status(404).json({ success: false, message: 'Rider profile not found' });
    }

    const riderGeo = require('../services/riderGeoCache.service');
    await riderGeo.syncFromRider(rider);

    if (rider.activeOrderId) {
      const io = req.app.get('io');
      if (io) {
        io.to(`order_${rider.activeOrderId}`).emit('rider:locationUpdate', {
          riderId: req.user._id,
          orderId: rider.activeOrderId,
          location: { latitude: lat, longitude: lng },
          timestamp: now,
        });
      }
    }

    res.json({
      success: true,
      data: {
        ...rider.currentLocation,
        lastLocationAt: rider.lastLocationAt,
      },
    });
  } catch (error) {
    console.error('updateLocation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Accept Order Broadcast (atomic session-based assignment)
 * @route   POST /api/riders/orders/:id/accept
 */
const acceptBroadcast = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { id } = req.params;
    let order;
    let broadcastRiderIds = [];

    await session.withTransaction(async () => {
      const targetOrder = await Order.findById(id).session(session);
      if (!targetOrder) {
        const err = new Error('Order not found.');
        err.statusCode = 404;
        throw err;
      }

      if (targetOrder.deliveryMethod !== 'rider') {
        const err = new Error('This order is not available for rider delivery.');
        err.statusCode = 400;
        throw err;
      }
      if (targetOrder.status !== 'ready') {
        const err = new Error('Order is not ready for pickup yet.');
        err.statusCode = 400;
        throw err;
      }
      if (targetOrder.riderStatus !== 'pending') {
        const err = new Error('This order is no longer available for acceptance.');
        err.statusCode = 409;
        throw err;
      }
      const riderInBroadcast = (targetOrder.riderBroadcasts || []).some(
        (uid) => uid.toString() === req.user._id.toString()
      );
      if (!riderInBroadcast) {
        const err = new Error('You were not invited to accept this order.');
        err.statusCode = 403;
        throw err;
      }

      // Wallet balance check: Rider must have at least ₹500 online balance to accept any COD order
      const isCodOrder = ['cod', 'partialCod'].includes(targetOrder.paymentType) ||
        targetOrder.doorPaymentMode === 'cash';
      if (isCodOrder) {
        const { getOrCreateWallet } = require('./wallet.controller');
        const riderWallet = await getOrCreateWallet(req.user._id, 'rider');
        if (riderWallet.balance < 500) {
          const err = new Error(
            `Insufficient wallet balance. You need at least ₹500 online balance to accept COD orders. Current balance: ₹${riderWallet.balance.toFixed(2)}`
          );
          err.statusCode = 403;
          throw err;
        }
      }

      broadcastRiderIds = (targetOrder.riderBroadcasts || []).map((uid) => uid.toString());

      const rider = await Rider.findOneAndUpdate(
        {
          userId: req.user._id,
          accountStatus: 'active',
          $or: [{ activeOrderId: null }, { activeOrderId: { $exists: false } }],
        },
        { $set: { activeOrderId: id } },
        { new: true, session }
      );

      if (!rider) {
        const err = new Error('You already have an active order or your account is unavailable.');
        err.statusCode = 409;
        throw err;
      }

      order = await Order.findOneAndUpdate(
        {
          _id: id,
          riderId: null,
          riderStatus: 'pending',
          status: 'ready',
          deliveryMethod: 'rider',
        },
        { $set: { riderId: req.user._id, riderStatus: 'accepted' } },
        { new: true, session }
      );

      if (!order) {
        const err = new Error('Order was already accepted by another rider or is not available.');
        err.statusCode = 409;
        throw err;
      }
    });

    const populatedOrder = await Order.findById(order._id)
      .populate('customerId', 'name phone avatar')
      .populate('riderId', 'name phone avatar')
      .populate({
        path: 'kitchenId',
        select: 'name address location ownerId upiId paymentMethods',
        populate: { path: 'ownerId', select: 'phone name' },
      });

    const io = req.app.get('io');
    const { clearRiderSearchExpiry, emitRiderStatusToKitchen } = require('../services/riderBroadcast.service');
    clearRiderSearchExpiry(order._id);

    if (io) {
      const orderIdStr = order._id.toString();
      for (const uid of broadcastRiderIds) {
        if (uid !== req.user._id.toString()) {
          io.to(`rider_${uid}`).emit('rider:orderRevoked', orderIdStr);
        }
      }

      const payload = {
        status: populatedOrder.status || order.status,
        orderId: order._id,
        order: populatedOrder,
        riderStatus: populatedOrder.riderStatus,
      };
      io.to(`order_${order._id}`).emit('order:statusUpdate', payload);
      if (order.kitchenId) {
        io.to(`kitchen_${order.kitchenId}`).emit('order:statusUpdate', payload);
        await emitRiderStatusToKitchen(io, populatedOrder, populatedOrder.riderStatus, populatedOrder);
      }
    }

    return res.json({
      success: true,
      message: 'Order assigned to you successfully!',
      data: populatedOrder,
    });
  } catch (error) {
    console.error('acceptBroadcast error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Unable to accept order',
    });
  } finally {
    await session.endSession();
  }
};

/**
 * @desc    Reject Order Broadcast
 * @route   POST /api/riders/orders/:id/reject
 */
const rejectBroadcast = async (req, res) => {
  try {
    const { id } = req.params;
    const riderId = req.user._id;

    const updated = await Order.findOneAndUpdate(
      {
        _id: id,
        riderStatus: 'pending',
        riderId: null,
        deliveryMethod: 'rider',
        status: 'ready',
        riderBroadcasts: riderId,
        riderRejections: { $ne: riderId },
      },
      { $addToSet: { riderRejections: riderId } },
      { new: true }
    );

    if (!updated) {
      const existing = await Order.findById(id).select('riderStatus riderBroadcasts riderRejections riderId');
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Order not found.' });
      }
      if (existing.riderId) {
        return res.status(409).json({ success: false, message: 'Order already accepted by a rider.' });
      }
      const wasInvited = (existing.riderBroadcasts || []).some((uid) => uid.toString() === riderId.toString());
      if (!wasInvited) {
        return res.status(403).json({ success: false, message: 'You were not invited to reject this order.' });
      }
      if ((existing.riderRejections || []).some((uid) => uid.toString() === riderId.toString())) {
        return res.json({ success: true, message: 'Order already rejected.' });
      }
      return res.status(409).json({ success: false, message: 'Order is no longer available for rejection.' });
    }

    const broadcastCount = (updated.riderBroadcasts || []).length;
    const rejectionCount = (updated.riderRejections || []).length;
    if (broadcastCount > 0 && rejectionCount >= broadcastCount) {
      const rejectedAll = await Order.findOneAndUpdate(
        {
          _id: id,
          riderStatus: 'pending',
          riderId: null,
        },
        { $set: { riderStatus: 'rejected_all' } },
        { new: true }
      );
      if (rejectedAll) {
        const io = req.app.get('io');
        const {
          emitRiderStatusToKitchen,
          clearRiderSearchExpiry,
        } = require('../services/riderBroadcast.service');
        // Stop 40s ignored_all timer — all invitees already rejected
        clearRiderSearchExpiry(id);
        if (io) {
          await emitRiderStatusToKitchen(io, rejectedAll, 'rejected_all');
        }
      }
    }

    res.json({
      success: true,
      message: 'Order rejected.',
    });
  } catch (error) {
    console.error('rejectBroadcast error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Verify Pickup OTP at Kitchen
 * @route   PUT /api/riders/orders/:id/pickup
 */
const verifyPickup = async (req, res) => {
  try {
    const { id } = req.params;
    const { otp } = req.body;

    const order = await Order.findOne({ _id: id, riderId: req.user._id });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    if (order.status !== 'ready') {
      return res.status(400).json({
        success: false,
        message: 'Kitchen has not marked the order ready yet.',
      });
    }

    // Seller verified handover — rider confirms pickup without re-entering OTP
    if (order.kitchenHandoverAt) {
      order.status = 'outForDelivery';
      order.outForDeliveryAt = new Date();
      await order.save();
    } else {
      if (order.pickupOtp !== otp && !isDevOtpAllowed(otp)) {
        return res.status(400).json({ success: false, message: 'Invalid Pickup OTP.' });
      }

      order.status = 'outForDelivery';
      order.outForDeliveryAt = new Date();
      await order.save();
    }

    const populatedOrder = await Order.findById(order._id)
      .populate('customerId', 'name phone avatar')
      .populate({
        path: 'kitchenId',
        select: 'name address location ownerId upiId paymentMethods',
        populate: {
          path: 'ownerId',
          select: 'phone name'
        }
      });

    res.json({
      success: true,
      message: 'Order picked up successfully! Out for delivery.',
      data: populatedOrder || order,
    });
    
    // Emit status update to customer and kitchen
    const io = req.app.get('io');
    if (io) {
      const payload = {
        status: order.status,
        orderId: order._id,
        order: populatedOrder || order
      };
      io.to(`order_${order._id}`).emit('order:statusUpdate', payload);
      if (order.kitchenId || populatedOrder?.kitchenId?._id) {
        const kId = order.kitchenId || populatedOrder.kitchenId._id;
        io.to(`kitchen_${kId}`).emit('order:statusUpdate', payload);
      }
    }
  } catch (error) {
    console.error('verifyPickup error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Verify Drop OTP at Customer & Reconcile Ledger
 * @route   PUT /api/riders/orders/:id/drop
 */
const verifyDrop = async (req, res) => {
  try {
    const { id } = req.params;
    const { otp, doorPaymentMode } = req.body;

    const order = await Order.findOne({ _id: id, riderId: req.user._id });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    if (order.dropOtp !== otp && !isDevOtpAllowed(otp)) {
      return res.status(400).json({ success: false, message: 'Invalid Drop OTP.' });
    }

    if (order.status === 'delivered') {
      return res.status(400).json({ success: false, message: 'Order is already delivered.' });
    }

    if (order.status !== 'outForDelivery') {
      return res.status(400).json({
        success: false,
        message: 'Order must be out for delivery before completing drop.',
      });
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    // Door QR/online is self-reported — store claim only; never mark paid without gateway proof
    order.doorPaymentMode = doorPaymentMode === 'online' ? 'online' : 'cash';
    await order.save();

    await recordDeliveredOrderStats(order, { logPrefix: '[rider/delivery]' });

    // Reconcile Wallet Ledgers (Cases 1 - 4) — cash-held path for unverified door claims
    await reconcileOrderDelivery(order);

    const { getOrCreateWallet } = require('./wallet.controller');
    const riderWallet = await getOrCreateWallet(req.user._id, 'rider');
    const updates = { activeOrderId: null };

    if (riderWallet.balance < 500) {
      updates.isOnline = false;
      updates.dutyStartedAt = null;
      const io = req.app.get('io');
      if (io) {
        // Emit to the specific rider's room
        io.to(`rider_${req.user._id}`).emit('rider:kicked_offline', { 
          reason: 'low_balance', 
          message: 'Your wallet balance is below ₹500. You have been taken offline.' 
        });
      }
    }

    // Clear activeOrderId and update status
    await Rider.findOneAndUpdate(
      { userId: req.user._id },
      { $set: updates }
    );

    if (updates.isOnline === false) {
      const riderGeo = require('../services/riderGeoCache.service');
      await riderGeo.removeRider(req.user._id);
    }

    const populatedOrder = await Order.findById(order._id)
      .populate('customerId', 'name phone avatar')
      .populate({
        path: 'kitchenId',
        select: 'name address location ownerId upiId paymentMethods',
        populate: {
          path: 'ownerId',
          select: 'phone name'
        }
      });

    res.json({
      success: true,
      message: 'Order delivered successfully! Ledger updated.',
      data: populatedOrder || order,
    });

    // Emit status update to customer and kitchen
    const io = req.app.get('io');
    if (io) {
      const payload = {
        status: order.status,
        orderId: order._id,
        order: populatedOrder || order,
      };
      io.to(`order_${order._id}`).emit('order:statusUpdate', payload);
      io.to(`order_${order._id}`).emit('order:delivered', { orderId: order._id, order: populatedOrder || order });
      if (order.kitchenId || populatedOrder?.kitchenId?._id) {
        const kId = order.kitchenId || populatedOrder.kitchenId._id;
        io.to(`kitchen_${kId}`).emit('order:statusUpdate', payload);
      }
    }
  } catch (error) {
    console.error('verifyDrop error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get Rider Orders History (Active & Past)
 * @route   GET /api/riders/orders/history
 */
const getOrdersHistory = async (req, res) => {
  try {
    const { date, page = 1, limit = 20 } = req.query;
    const pageNumber = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);

    let query = { riderId: req.user._id };

    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: startDate, $lte: endDate };
    }

    // Always fetch active order if on first page
    let activeOrder = null;
    if (pageNumber === 1) {
      const activeQuery = { ...query, status: { $in: ['preparing', 'accepted', 'ready', 'outForDelivery'] } };
      activeOrder = await Order.findOne(activeQuery)
        .populate({
          path: 'kitchenId',
          select: 'name address location ownerId upiId paymentMethods',
          populate: { path: 'ownerId', select: 'phone name' }
        })
        .populate('customerId', 'name phone');
    }

    // Fetch completed/cancelled orders with pagination
    query.status = { $in: ['delivered', 'cancelled', 'autoCancelled', 'auto_cancelled'] };
    const totalOrders = await Order.countDocuments(query);
    
    const completedOrders = await Order.find(query)
      .populate({
        path: 'kitchenId',
        select: 'name address location ownerId upiId paymentMethods',
        populate: { path: 'ownerId', select: 'phone name' }
      })
      .populate('customerId', 'name phone')
      .sort({ createdAt: -1 })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize);

    res.json({
      success: true,
      data: {
        activeOrder: activeOrder || null,
        completedOrders,
        pagination: {
          total: totalOrders,
          page: pageNumber,
          pages: Math.ceil(totalOrders / pageSize),
          hasMore: pageNumber * pageSize < totalOrders
        }
      },
    });
  } catch (error) {
    console.error('getOrdersHistory error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const isValidIndianMobile = (value) => /^[6-9]\d{9}$/.test(String(value || '').replace(/\D/g, '').slice(-10));
const isValidUpiOrMobile = (value) => {
  const v = String(value || '').trim();
  if (!v) return true;
  if (v.includes('@')) return /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(v);
  return isValidIndianMobile(v);
};
const isValidIfsc = (value) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(value || '').trim().toUpperCase());
const isValidAccountNumber = (value) => /^\d{9,18}$/.test(String(value || '').replace(/\s/g, ''));
const normalizeVehiclePlate = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isValidVehiclePlate = (value) => {
  const plate = normalizeVehiclePlate(value);
  if (!plate) return true;
  return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(plate);
};

/**
 * @desc    Update Rider Profile (Name, Photo)
 * @route   PUT /api/riders/profile
 */
const updateProfile = async (req, res) => {
  try {
    const { name, avatar, dutyLocation, paymentMethods, vehicleName, vehicleNumber, documents, expoPushToken } = req.body;
    const User = require('../models/User');
    
    let rider = await Rider.findOne({ userId: req.user._id });
    const phone = req.user.phone || req.user._doc?.phone || req.body.phone;
    if (!rider) {
      if (!phone) {
        return res.status(400).json({ success: false, message: 'Phone number is required to create rider profile' });
      }
      rider = new Rider({ userId: req.user._id, phone });
    } else if (!rider.phone) {
      if (!phone) {
        return res.status(400).json({ success: false, message: 'Phone number is required on rider profile' });
      }
      rider.phone = phone;
    }

    if (name !== undefined) {
      const cleanName = String(name || '').trim();
      if (!cleanName || cleanName.length < 2) {
        return res.status(400).json({ success: false, message: 'Name must be at least 2 characters' });
      }
      if (cleanName.length > 60) {
        return res.status(400).json({ success: false, message: 'Name is too long' });
      }
      rider.name = cleanName;
      await User.findByIdAndUpdate(req.user._id, { name: cleanName });
    }

    if (dutyLocation) {
      rider.dutyLocation = dutyLocation;
    }

    if (avatar !== undefined) {
      if (avatar === '' || avatar === null) {
        rider.photo = '';
        await User.findByIdAndUpdate(req.user._id, { avatar: '' });
      } else if (typeof avatar === 'string' && avatar.startsWith('data:image')) {
        const { uploadImage } = require('../config/cloudinary');
        const uploadRes = await uploadImage(avatar, 'apnamenu/avatars');
        rider.photo = uploadRes.url;
        await User.findByIdAndUpdate(req.user._id, { avatar: uploadRes.url });
      } else if (typeof avatar === 'string' && !avatar.startsWith('file://')) {
        rider.photo = avatar;
        await User.findByIdAndUpdate(req.user._id, { avatar });
      }
    }

    if (expoPushToken !== undefined) {
      rider.expoPushToken = expoPushToken;
    }

    if (paymentMethods) {
      if (!rider.paymentMethods) {
        rider.paymentMethods = {};
      }

      if (paymentMethods.phonePe !== undefined) {
        rider.paymentMethods.phonePe = String(paymentMethods.phonePe || '').trim();
      }
      if (paymentMethods.upiId !== undefined) {
        rider.paymentMethods.upiId = String(paymentMethods.upiId || '').trim();
      }

      if (paymentMethods.bankDetails) {
        const nextBank = {
          ...rider.paymentMethods.bankDetails,
          ...paymentMethods.bankDetails,
        };
        const accountNumber = String(nextBank.accountNumber || '').replace(/\s/g, '');
        const ifsc = String(nextBank.ifsc || '').trim().toUpperCase();
        const accountName = String(nextBank.accountName || '').trim();
        const anyBankField = !!(accountNumber || ifsc || accountName);
        if (anyBankField) {
          if (!accountName || accountName.length < 2) {
            return res.status(400).json({ success: false, message: 'Account holder name is required' });
          }
          if (!isValidAccountNumber(accountNumber)) {
            return res.status(400).json({ success: false, message: 'Enter a valid bank account number (9–18 digits)' });
          }
          if (!isValidIfsc(ifsc)) {
            return res.status(400).json({ success: false, message: 'Enter a valid IFSC code' });
          }
        }
        rider.paymentMethods.bankDetails = {
          accountNumber: accountNumber || '',
          ifsc: ifsc || '',
          accountName: accountName || '',
        };
      }

      // Handle QR Code image base64 upload
      if (paymentMethods.qrCodeImage && paymentMethods.qrCodeImage.startsWith('data:image')) {
        const { uploadImage } = require('../config/cloudinary');
        const uploadRes = await uploadImage(paymentMethods.qrCodeImage, 'apnamenu/payment-qrs');
        rider.paymentMethods.qrCodeUrl = uploadRes.url;
      } else if (paymentMethods.qrCodeUrl !== undefined) {
        // Handle deletion or direct URL assignment
        rider.paymentMethods.qrCodeUrl = paymentMethods.qrCodeUrl;
      }

      rider.markModified('paymentMethods');
    }

    if (vehicleName !== undefined || vehicleNumber !== undefined) {
      const nextName = vehicleName !== undefined
        ? String(vehicleName || '').trim()
        : String(rider.vehicleName || '').trim();
      const nextNumberRaw = vehicleNumber !== undefined
        ? String(vehicleNumber || '').trim().toUpperCase()
        : String(rider.vehicleNumber || '').trim().toUpperCase();
      const nextNumber = nextNumberRaw.replace(/\s+/g, '');

      if ((nextName && !nextNumber) || (!nextName && nextNumber)) {
        return res.status(400).json({
          success: false,
          message: 'Both vehicle name and registration number are required',
        });
      }
      if (nextNumber && !isValidVehiclePlate(nextNumber)) {
        return res.status(400).json({
          success: false,
          message: 'Enter a valid vehicle registration number (e.g. MH12AB1234)',
        });
      }
      if (vehicleName !== undefined) rider.vehicleName = nextName;
      if (vehicleNumber !== undefined) rider.vehicleNumber = nextNumber;
    }

    if (documents) {
      if (!rider.documents) {
        rider.documents = {};
      }
      const { uploadPrivateDocument } = require('../config/cloudinary');

      if (documents.aadhaarImage && documents.aadhaarImage.startsWith('data:image')) {
        const uploadRes = await uploadPrivateDocument(documents.aadhaarImage, 'apnamenu/documents');
        rider.documents.aadhaarUrl = uploadRes.url;
        rider.documents.aadhaarPublicId = uploadRes.publicId;
      } else if (documents.aadhaarUrl !== undefined) {
        rider.documents.aadhaarUrl = documents.aadhaarUrl;
        if (!documents.aadhaarUrl) rider.documents.aadhaarPublicId = '';
      }

      if (documents.panImage && documents.panImage.startsWith('data:image')) {
        const uploadRes = await uploadPrivateDocument(documents.panImage, 'apnamenu/documents');
        rider.documents.panUrl = uploadRes.url;
        rider.documents.panPublicId = uploadRes.publicId;
      } else if (documents.panUrl !== undefined) {
        rider.documents.panUrl = documents.panUrl;
        if (!documents.panUrl) rider.documents.panPublicId = '';
      }

      if (documents.drivingLicenseImage && documents.drivingLicenseImage.startsWith('data:image')) {
        const uploadRes = await uploadPrivateDocument(documents.drivingLicenseImage, 'apnamenu/documents');
        rider.documents.drivingLicenseUrl = uploadRes.url;
        rider.documents.drivingLicensePublicId = uploadRes.publicId;
      } else if (documents.drivingLicenseUrl !== undefined) {
        rider.documents.drivingLicenseUrl = documents.drivingLicenseUrl;
        if (!documents.drivingLicenseUrl) rider.documents.drivingLicensePublicId = '';
      }

      rider.markModified('documents');
    }

    await rider.save();
    res.json({ success: true, message: 'Profile updated successfully', data: rider });
  } catch (error) {
    console.error('updateProfile error:', error);
    res.status(500).json({ success: false, message: error.message });  }
};

/**
 * @desc    Get Rider stats for a day or date range (deliveries, earnings, rating)
 * @route   GET /api/riders/stats?date=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
const getRiderStats = async (req, res) => {
  try {
    const { date, endDate } = req.query;
    let startOfRange, endOfRange;

    const parseYmd = (value) => {
      if (!value || !String(value).includes('-')) return null;
      const parts = String(value).split('-').map(Number);
      if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
      return parts;
    };

    const startParts = parseYmd(date);
    const endParts = parseYmd(endDate) || startParts;

    if (startParts) {
      startOfRange = new Date(startParts[0], startParts[1] - 1, startParts[2], 0, 0, 0, 0);
      const ep = endParts || startParts;
      endOfRange = new Date(ep[0], ep[1] - 1, ep[2], 23, 59, 59, 999);
      // Guard: if end before start, treat as single day
      if (endOfRange < startOfRange) {
        endOfRange = new Date(startParts[0], startParts[1] - 1, startParts[2], 23, 59, 59, 999);
      }
    } else {
      const now = new Date();
      startOfRange = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      endOfRange = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    }

    // Find all delivered orders for the rider in this range
    const Order = require('../models/Order');
    const orders = await Order.find({
      riderId: req.user._id,
      status: 'delivered',
      $or: [
        { deliveredAt: { $gte: startOfRange, $lte: endOfRange } },
        { updatedAt: { $gte: startOfRange, $lte: endOfRange } }
      ]
    }).lean();
    
    let totalEarning = 0;
    let onlinePayments = 0;
    let codPayments = 0;
    let totalRating = 0;
    let ratingCount = 0;
    
    for (const order of orders) {
      const fee = getDelivererFeeEarning(order);
      totalEarning += fee;
      
      // Breakdown logic matching reconcileOrderDelivery
      const isDoorOnline = (order.paymentType === 'online' || (order.paymentType === 'partialCod' && order.doorPaymentMode === 'online'));
      
      if (isDoorOnline) {
        onlinePayments += fee; // Rider gets this digitally in their wallet
      } else {
        codPayments += fee; // Rider collected cash at door and kept their fee from it
      }
      
      const riderScore = order.rating?.riderRating;
      if (riderScore >= 1 && riderScore <= 5) {
        totalRating += riderScore;
        ratingCount++;
      }
    }
    
    let avgRating = 0;
    if (ratingCount > 0) {
      avgRating = Number((totalRating / ratingCount).toFixed(1));
    }

    res.json({
      success: true,
      data: {
        totalDeliveries: orders.length,
        totalEarning,
        onlinePayments,
        codPayments,
        rating: avgRating,
        ratingCount,
        from: startOfRange,
        to: endOfRange,
      }
    });
  } catch (error) {
    console.error('getRiderStats error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get Rider Earnings Summary (Today, Week, Month, Year)
 * @route   GET /api/riders/earnings-summary
 */
const getEarningsSummary = async (req, res) => {
  try {
    const Order = require('../models/Order');
    
    // Timeframes
    const now = new Date();
    
    // Today
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    
    // This Week (assuming week starts on Monday)
    const dayOfWeek = now.getDay() || 7; // Convert Sunday(0) to 7
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - dayOfWeek + 1);
    
    // This Month
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    
    // This Year
    const startOfYear = new Date(now.getFullYear(), 0, 1, 0, 0, 0);

    const Wallet = require('../models/Wallet');
    const Rider = require('../models/Rider');

    const [orders, wallet, riderDoc] = await Promise.all([
      Order.find({
        riderId: req.user._id,
        status: 'delivered',
      }).select('deliveryFee platformFee deliveredAt updatedAt').lean(),
      Wallet.findOne({ userId: req.user._id, role: 'rider' }).lean(),
      Rider.findOne({ userId: req.user._id }).lean()
    ]);

    let lifetimeEarning = 0;
    let todayEarning = 0;
    let weekEarning = 0;
    let monthEarning = 0;
    let yearEarning = 0;

    for (const order of orders) {
      const fee = getDelivererFeeEarning(order);
      const deliveredTime = new Date(order.deliveredAt || order.updatedAt).getTime();
      
      lifetimeEarning += fee;
      
      if (deliveredTime >= startOfYear.getTime()) {
        yearEarning += fee;
      }
      if (deliveredTime >= startOfMonth.getTime()) {
        monthEarning += fee;
      }
      if (deliveredTime >= startOfWeek.getTime()) {
        weekEarning += fee;
      }
      if (deliveredTime >= startOfToday.getTime()) {
        todayEarning += fee;
      }
    }

    const totalLifetimeEarnings = Math.max(
      lifetimeEarning,
      riderDoc?.totalEarnings || 0,
      wallet?.totalEarned || 0
    );

    res.json({
      success: true,
      data: {
        todayEarning,
        weekEarning,
        monthEarning,
        yearEarning,
        lifetimeEarning: totalLifetimeEarnings,
        totalLifetimeEarnings
      }
    });

  } catch (error) {
    console.error('getEarningsSummary error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get Rider Profile
 * @route   GET /api/riders/profile
 */
const getProfile = async (req, res) => {
  try {
    const Order = require('../models/Order');
    const Wallet = require('../models/Wallet');
    const { getSignedDocumentUrl } = require('../config/cloudinary');
    const rider = await Rider.findOne({ userId: req.user._id }).lean();
    if (!rider) {
      return res.status(404).json({ success: false, message: 'Rider profile not found' });
    }

    const [wallet, deliveredOrders, ratedOrders] = await Promise.all([
      Wallet.findOne({ userId: req.user._id, role: 'rider' }).lean(),
      Order.find({ riderId: req.user._id, status: 'delivered' }).select('deliveryFee platformFee').lean(),
      Order.find({
        riderId: req.user._id,
        status: 'delivered',
        'rating.riderRating': { $gte: 1, $lte: 5 },
      }).select('rating.riderRating').lean(),
    ]);
    const orderSum = deliveredOrders.reduce((sum, o) => sum + getDelivererFeeEarning(o), 0);

    const totalLifetimeEarnings = Math.max(
      rider.totalEarnings || 0,
      wallet?.totalEarned || 0,
      orderSum
    );

    const ratingCount = ratedOrders.length;
    const ratingAvg = ratingCount
      ? Math.round(
          (ratedOrders.reduce((sum, o) => sum + (o.rating?.riderRating || 0), 0) / ratingCount) * 10
        ) / 10
      : 0;

    const documents = { ...(rider.documents || {}) };
    if (documents.aadhaarPublicId) {
      documents.aadhaarUrl = getSignedDocumentUrl(documents.aadhaarPublicId) || documents.aadhaarUrl;
    }
    if (documents.panPublicId) {
      documents.panUrl = getSignedDocumentUrl(documents.panPublicId) || documents.panUrl;
    }
    if (documents.drivingLicensePublicId) {
      documents.drivingLicenseUrl =
        getSignedDocumentUrl(documents.drivingLicensePublicId) || documents.drivingLicenseUrl;
    }
    // Never expose raw Cloudinary public IDs to the client
    delete documents.aadhaarPublicId;
    delete documents.panPublicId;
    delete documents.drivingLicensePublicId;

    res.json({
      success: true,
      data: {
        ...rider,
        documents,
        accountStatus:
          req.user.accountStatus === 'suspended' || req.user.accountStatus === 'deleted'
            ? req.user.accountStatus
            : rider.accountStatus,
        totalEarnings: totalLifetimeEarnings,
        totalLifetimeEarnings: totalLifetimeEarnings,
        totalDeliveries: Math.max(rider.totalDeliveries || 0, deliveredOrders.length),
        rating: ratingAvg,
        ratingCount,
      }
    });
  } catch (error) {
    console.error('getProfile error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customerId', 'name phone avatar')
      .populate({
        path: 'kitchenId',
        select: 'name address location ownerId upiId paymentMethods',
        populate: {
          path: 'ownerId',
          select: 'phone name'
        }
      });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Ownership check: only the assigned rider or a broadcast candidate may view
    const isAssignedRider =
      order.riderId && String(order.riderId) === String(req.user._id);

    const isBroadcastCandidate =
      Array.isArray(order.riderBroadcasts) &&
      order.riderBroadcasts.some((id) => String(id) === String(req.user._id));

    if (!isAssignedRider && !isBroadcastCandidate) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this order',
      });
    }

    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    console.error('getOrderById error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * @desc    Logout rider (sets isOnline to false, clears expo token)
 * @route   POST /api/riders/logout
 */
const logout = async (req, res) => {
  try {
    const { bumpTokenVersion } = require('../utils/authTokens');
    const { clearAuthCache } = require('../middleware/auth');

    const rider = await Rider.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: {
          isOnline: false,
          dutyStartedAt: null,
          expoPushToken: null,
        },
      },
      { new: true }
    );

    // Revoke this JWT and any other devices for this rider account
    await bumpTokenVersion(req.user._id);
    clearAuthCache(req.user._id);

    await User.findByIdAndUpdate(req.user._id, { $set: { fcmToken: null } }).catch(() => null);

    if (rider) {
      console.log(`[Rider Logout] ${req.user.name || req.user._id} marked offline + session revoked.`);
    }

    const riderGeo = require('../services/riderGeoCache.service');
    await riderGeo.removeRider(req.user._id);

    res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Rider logout error:', error);
    res.status(500).json({ success: false, message: 'Failed to logout on server' });
  }
};

/**
 * @desc    Get all pending broadcast orders for this rider
 * @route   GET /api/riders/orders/pending-broadcasts
 */
const getPendingBroadcasts = async (req, res) => {
  try {
    const Order = require('../models/Order');
    const riderId = req.user._id;

    const pendingOrders = await Order.find({
      deliveryMethod: 'rider',
      status: 'ready',
      riderStatus: 'pending',
      riderId: null,
      riderBroadcasts: riderId,
      riderRejections: { $ne: riderId }
    })
      .populate('customerId', 'name phone avatar')
      .populate({
        path: 'kitchenId',
        select: 'name address location phone'
      })
      .sort({ riderSearchStartedAt: 1 })
      .lean();

    const data = pendingOrders.map((o) => {
      const started = o.riderSearchStartedAt || o.updatedAt || o.createdAt;
      const ts = started ? new Date(started).getTime() : Date.now();
      const receivedAt = Number.isFinite(ts) ? ts : Date.now();
      return {
        ...o,
        receivedAt,
        broadcastAt: receivedAt,
      };
    });

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('getPendingBroadcasts error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  logout,
  toggleDuty,
  updateLocation,
  acceptBroadcast,
  verifyPickup,
  verifyDrop,
  getOrdersHistory,
  updateProfile,
  getRiderStats,
  getEarningsSummary,
  getProfile,
  getOrderById,
  rejectBroadcast,
  getPendingBroadcasts,
};

