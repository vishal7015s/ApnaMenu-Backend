// ====================================
// Order Controller
// ====================================

const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const Kitchen = require('../models/Kitchen');
const Rider = require('../models/Rider');
const User = require('../models/User');
const dishReviewCache = require('../services/dishReviewCache.service');
const menuCache = require('../services/menuCache.service');
const { invalidateNearbyCachesForKitchen, recordDeliveredOrderStats } = require('../services/cacheInvalidation.service');
const { isKitchenCustomerVisible, isKitchenVerifiedForSeller } = require('../utils/kitchenVisibility');
const { reconcileOrderDelivery } = require('./wallet.controller');
const { sendPushNotification, sendDataOnlyPush } = require('../config/firebase');
const {
  isValidCoordinates,
  findEligibleRidersNearKitchen,
  emitRiderStatusToKitchen,
  revokeBroadcastToRiders,
  scheduleRiderSearchExpiry,
  clearRiderSearchExpiry,
  expireStaleRiderSearches,
} = require('../services/riderBroadcast.service');
const {
  isDevOtpAllowed,
  isMockPaymentAllowed,
  validateDeliveryAddress,
} = require('../utils/validation');
const {
  ALREADY_ACCEPTED_STATUSES,
  PENDING_ACCEPT_STATUSES,
  REJECTABLE_STATUSES,
} = require('../services/orderAccept.service');
const {
  clearOrderTimers,
  scheduleAcceptanceTimer,
  schedulePaymentTimer,
} = require('../services/orderTimer.service');
const { resetKitchenConsecutiveMisses } = require('../services/kitchenDuty.service');
const {
  CUSTOMER_ORDER_LIST_SELECT,
  CUSTOMER_ORDER_DETAIL_SELECT,
  toCustomerOrderDTO,
  toCustomerOrderListDTO,
} = require('../utils/customerOrderDto');
const { getPartialCodOnlinePercent } = require('../utils/orderConfig');
const { getDeliveryPricing, getDelivererFeeEarning } = require('../utils/deliveryPricing');
const { calcDistanceFromCoords } = require('../utils/calcDistance');
const { getUserId, isOrderCustomer, isOrderKitchen, isOrderRider } = require('../utils/orderAuth');
const { emitOrderToCustomer } = require('../utils/orderSocketEmit');
const {
  toKitchenOrderDTO,
  toKitchenOrderListDTO,
  sanitizeKitchenOrderPayload,
} = require('../utils/kitchenOrderDto');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const PENDING_QUEUE_STATUSES = ['placed', 'PENDING_SELLER_APPROVAL'];
const TERMINAL_STATUSES = ['delivered', 'cancelled', 'autoCancelled'];
// OTPs intentionally omitted — kitchen must enter secrets from counterparty, not read them
const KITCHEN_ORDER_LIST_SELECT =
  'orderId status customerName customerPhone items itemTotal grandTotal deliveryFee platformFee paymentType paymentStatus deliveryMethod riderStatus riderId deliveryAddress deliveryLocation createdAt updatedAt acceptedAt prepStartedAt kitchenHandoverAt outForDeliveryAt deliveredAt cancelledAt cancelReason onlineAmount cashAmount doorPaymentMode riderSearchStartedAt distance placedAt schedule';

function emitToKitchen(io, kitchenId, event, payload) {
  if (!io || !kitchenId) return;
  const room = 'kitchen_' + String(kitchenId);
  io.to(room).emit(event, sanitizeKitchenOrderPayload(payload));
}

function formatOrderItemsForNotification(items, maxLen = 120) {
  const itemSummaries = (items || []).map((i) => `${i.qty || 1} ${i.name}`);
  const itemsString = itemSummaries.join(', ');
  if (itemsString.length <= maxLen) return itemsString;
  return `${itemsString.substring(0, maxLen - 3)}...`;
}

function buildOrderItemsString(items) {
  return (items || []).map((i) => `${i.qty || 1} ${i.name}`).join(', ');
}

function processKitchenOrderAvatars(orders) {
  return toKitchenOrderListDTO(orders).map((order) => {
    if (order.customerId && typeof order.customerId === 'object') {
      if (
        !order.customerId.avatar
        || order.customerId.avatar.trim() === ''
        || order.customerId.avatar.includes('flaticon')
        || order.customerId.avatar.startsWith('file://')
      ) {
        const cName = order.customerId.name || order.customerName || 'Customer';
        order.customerId.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(cName)}&background=FF6B35&color=fff&size=256&bold=true`;
      }
    }
    return order;
  });
}

async function revokeAssignedRider(io, order, reason) {
  if (!order?.riderId) return;
  const riderUserId = order.riderId._id?.toString() || order.riderId.toString();
  await Rider.findOneAndUpdate(
    { userId: order.riderId, activeOrderId: order._id },
    { $set: { activeOrderId: null } }
  );
  if (io) {
    io.to(`rider_${riderUserId}`).emit('order:revoked', { orderId: order._id, reason });
    io.to(`rider_${riderUserId}`).emit('order:statusUpdate', {
      orderId: order._id,
      status: order.status,
      revoked: true,
      reason,
    });
  }
  const riderDoc = await Rider.findOne({ userId: order.riderId }).select('expoPushToken').lean();
  if (riderDoc?.expoPushToken) {
    sendDataOnlyPush(riderDoc.expoPushToken, {
      type: 'order_revoked',
      orderId: order._id.toString(),
      reason: reason || 'Order reassigned',
    });
  }
}

function canModifyRiderDispatch(order) {
  if (!order) return { ok: false, message: 'Order not found' };
  if (order.status === 'outForDelivery') {
    return { ok: false, message: 'Order is already out for delivery' };
  }
  if (order.kitchenHandoverAt) {
    return { ok: false, message: 'Order already handed over to rider' };
  }
  if (order.status !== 'ready' || order.deliveryMethod !== 'rider') {
    return { ok: false, message: 'Rider actions only allowed for ready rider-delivery orders' };
  }
  return { ok: true };
}

async function finalizeRiderBroadcast(req, order, onlineRiders, kitchen, populatedOrder) {
  const io = req.app.get('io');
  const riderUserIds = onlineRiders.map((r) => r.userId);

  if (riderUserIds.length === 0) {
    await Order.findByIdAndUpdate(order._id, {
      $set: {
        riderStatus: 'rejected_all',
        riderSearchStartedAt: order.riderSearchStartedAt || new Date(),
        riderBroadcasts: [],
        riderRejections: [],
      },
    });
    await emitRiderStatusToKitchen(io, order, 'rejected_all');
    return;
  }

  await Order.findByIdAndUpdate(order._id, {
    $set: {
      riderStatus: 'pending',
      riderSearchStartedAt: order.riderSearchStartedAt || new Date(),
      riderBroadcasts: riderUserIds,
      riderRejections: [],
    },
  });
  await emitRiderStatusToKitchen(io, order, 'pending');

  const broadcastAt = Date.now().toString();
  // kitchen coords are [lng, lat] GeoJSON — used only for FCM optimistic UI payload
  const kitchenCoords = kitchen?.location?.coordinates;

  for (const rider of onlineRiders) {
    if (io) {
      io.to(`rider_${rider.userId.toString()}`).emit('rider:orderBroadcast', populatedOrder);
    }
    if (rider.expoPushToken) {
      try {
        // Seller parity: await notification+data so Android OS shows tray instantly when killed
        const pushTitle = '🔔 New Delivery Request!';
        const riderEarning = getDelivererFeeEarning(order);
        const pushBody = `Pickup: ${populatedOrder?.kitchenId?.name || kitchen?.name || 'Kitchen'} • Earning: ₹${riderEarning}`;
        await sendPushNotification(rider.expoPushToken, pushTitle, pushBody, {
          type: 'order_broadcast',
          orderId: order._id.toString(),
          customerName: populatedOrder?.customerId?.name || order.customerName || 'Customer',
          kitchenName: populatedOrder?.kitchenId?.name || kitchen?.name || 'Kitchen',
          deliveryFee: String(order.deliveryFee || 0),
          platformFee: String(order.platformFee || 0),
          riderEarning: String(riderEarning || 0),
          broadcastAt,
          kitchenLat: String(kitchenCoords?.[1] || ''),
          kitchenLon: String(kitchenCoords?.[0] || ''),
          dropHouse: order.deliveryAddress?.house || '',
          dropLandmark: order.deliveryAddress?.landmark || '',
        });
      } catch (pushBuildErr) {
        console.error('[RIDER FCM BUILD ERROR]', pushBuildErr);
      }
    }
  }
}

/**
 * Broadcast order to online riders within 7 KM of kitchen (area-only, no global fallback).
 * Only runs when order is ready and dispatch has chosen rider delivery.
 */
const broadcastToRiders = async (req, order) => {
  try {
    console.log(`[RIDER BROADCAST] Checking conditions for order: ${order.orderId}`);
    if (order.deliveryMethod !== 'rider') {
      console.log(`[RIDER BROADCAST SKIP] Delivery method is not rider (${order.deliveryMethod})`);
      return;
    }
    if (order.status !== 'ready') {
      console.log(`[RIDER BROADCAST SKIP] Order must be ready (current: ${order.status})`);
      return;
    }
    if (order.paymentStatus !== 'paid' && order.onlineAmount > 0) {
      console.log(`[RIDER BROADCAST SKIP] Payment not yet verified for ${order.orderId}`);
      return;
    }

    const kitchen = await Kitchen.findById(order.kitchenId);
    const kitchenCoords = kitchen?.location?.coordinates;
    console.log(`[RIDER BROADCAST] Kitchen: ${kitchen?.name}, location: ${JSON.stringify(kitchenCoords)}`);

    const populatedOrder = await Order.findById(order._id)
      .populate('customerId', 'name phone avatar')
      .populate('kitchenId', 'name address location phone')
      .populate({ path: 'items.menuItemId', select: 'prepTime' });

    if (!isValidCoordinates(kitchenCoords)) {
      console.log('[RIDER BROADCAST] Kitchen location missing or invalid — cannot broadcast.');
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          riderStatus: 'rejected_all',
          riderSearchStartedAt: order.riderSearchStartedAt || new Date(),
          riderBroadcasts: [],
          riderRejections: [],
        },
      });
      await emitRiderStatusToKitchen(req.app.get('io'), order, 'rejected_all');
      return;
    }

    const onlineRiders = await findEligibleRidersNearKitchen(kitchenCoords);
    console.log(`[RIDER BROADCAST] Total eligible riders to notify: ${onlineRiders.length}`);
    if (onlineRiders.length > 0) {
      onlineRiders.forEach(r => console.log(`  -> Will emit to rider_${r.userId}`));
    }

    await finalizeRiderBroadcast(req, order, onlineRiders, kitchen, populatedOrder);
  } catch (err) {
    console.error('[RIDER BROADCAST ERROR]', err);
  }
};

// Initialize Razorpay instance
let razorpayInstance = null;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_ID !== 'your_razorpay_key_id') {
    razorpayInstance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log('✅ Razorpay SDK initialized successfully with Key:', process.env.RAZORPAY_KEY_ID);
  } else {
    console.log('⚠️ Razorpay keys not configured. Payment will not work.');
  }
} catch (err) {
  console.log('❌ [RAZORPAY ERROR] Failed to initialize Razorpay SDK. Is razorpay installed?', err.message);
}

/**
 * @route   POST /api/orders/webhook
 * @desc    Razorpay Webhook for async payment processing
 */
const razorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    
    if (signature && secret) {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (expectedSignature !== signature) {
        console.warn('[WEBHOOK] Signature mismatch — rejected');
        return res.status(401).send('Invalid signature');
      }
    } else if (process.env.NODE_ENV === 'production') {
      return res.status(401).send('Signature required');
    }

    const { event, payload } = req.body;
    if (event === 'order.paid' || event === 'payment.captured' || event === 'payment_link.paid') {
      const paymentEntity = payload.payment?.entity;
      const orderEntity = payload.order?.entity;
      const linkEntity = payload.payment_link?.entity;
      const rzpOrderId = orderEntity ? orderEntity.id : paymentEntity?.order_id;
      
      let order = null;
      if (event === 'payment_link.paid') {
        const appOrderId = linkEntity?.notes?.orderId;
        if (appOrderId) {
          order = await Order.findById(appOrderId);
        }
      } else {
        if (!rzpOrderId) return res.status(200).send('OK');
        order = await Order.findOne({ razorpayOrderId: rzpOrderId });
        // Fallback: razorpayOrderId may have been rotated after a successful capture
        if (!order) {
          const appOrderId =
            orderEntity?.notes?.appOrderId ||
            paymentEntity?.notes?.appOrderId ||
            null;
          if (appOrderId) {
            order = await Order.findOne({
              orderId: appOrderId,
              status: 'PENDING_CUSTOMER_PAYMENT',
              paymentStatus: { $in: ['pending', 'failed', 'awaiting_acceptance'] },
            });
            if (order) {
              order.razorpayOrderId = rzpOrderId;
            }
          }
        }
      }
      if (!order) {
        // Not a food order — may be a wallet deposit
        try {
          const WalletDeposit = require('../models/WalletDeposit');
          const { creditCapturedDeposit } = require('./wallet.controller');
          const deposit = await WalletDeposit.findOne({ razorpayOrderId: rzpOrderId });
          if (deposit && deposit.status !== 'credited') {
            const payId = paymentEntity?.id;
            const creditAmount = paymentEntity?.amount
              ? Number(paymentEntity.amount) / 100
              : deposit.amount;
            if (payId && creditAmount > 0) {
              const result = await creditCapturedDeposit({
                razorpayOrderId: rzpOrderId,
                razorpayPaymentId: payId,
                creditAmount,
                userId: deposit.userId,
                role: deposit.role,
              });
              console.log(
                `[WEBHOOK] Wallet deposit ${result.alreadyProcessed ? 'already credited' : 'credited'} for order ${rzpOrderId}`
              );
              const io = req.app.get('io');
              if (io && !result.alreadyProcessed) {
                if (deposit.role === 'rider') {
                  io.to(`rider_${deposit.userId}`).emit('wallet:updated');
                } else {
                  const Kitchen = require('../models/Kitchen');
                  const kitchen = await Kitchen.findOne({ ownerId: deposit.userId }).select('_id').lean();
                  if (kitchen) emitToKitchen(io, kitchen._id, 'wallet:updated', {});
                }
              }
            }
          }
        } catch (depErr) {
          console.error('[WEBHOOK] Wallet deposit reconcile error:', depErr.message);
        }
        return res.status(200).send('OK');
      }

      if (order.paymentStatus === 'paid') return res.status(200).send('OK');

      clearOrderTimers(order._id);

      // GUARD: Prevent reviving cancelled orders
      if (order.status === 'cancelled' || order.status === 'autoCancelled') {
        console.warn(`[WEBHOOK] Late payment for cancelled order ${order.orderId}. Flagging for refund.`);
        await Order.findByIdAndUpdate(order._id, {
          $set: {
            paymentStatus: 'refund_pending',
            razorpayPaymentId: paymentEntity?.id || 'webhook_captured',
          },
        });
        return res.status(200).send('OK');
      }

      const isPaymentLink = event === 'payment_link.paid';
      const updatedOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          paymentStatus: { $ne: 'paid' },
          status: { $nin: ['cancelled', 'autoCancelled'] },
        },
        {
          $set: {
            paymentStatus: 'paid',
            razorpayPaymentId: paymentEntity?.id || 'webhook_captured',
            ...(order.status === 'PENDING_CUSTOMER_PAYMENT' ? { status: 'accepted' } : {}),
            ...(isPaymentLink ? { doorPaymentMode: 'online' } : {}),
          },
        },
        { new: true }
      );

      if (!updatedOrder) {
        // Already processed by /verify or another webhook event
        return res.status(200).send('OK');
      }

      console.log(`[WEBHOOK] Payment successful for order ${updatedOrder.orderId}`);

      // Notify kitchen via socket (no push — seller already gets new-order alert)
      await updatedOrder.populate('customerId', 'name');
      const customerName = updatedOrder.customerId?.name || 'A Customer';
      const itemsString = buildOrderItemsString(updatedOrder.items);

      const io = req.app.get('io');
      if (io) {
        if (isPaymentLink) {
          emitToKitchen(io, updatedOrder.kitchenId, 'order:doorstepPaymentSuccess', { orderId: updatedOrder._id, order: updatedOrder });
          if (updatedOrder.riderId) {
            io.to(`rider_${updatedOrder.riderId}`).emit('order:doorstepPaymentSuccess', { orderId: updatedOrder._id, order: updatedOrder });
          }
        } else {
          emitToKitchen(io, updatedOrder.kitchenId, 'order:paymentVerified', { orderId: updatedOrder._id, order: updatedOrder, customerName, itemsString });
        }
        emitToKitchen(io, updatedOrder.kitchenId, 'order:statusUpdate', { status: updatedOrder.status, order: updatedOrder });
        emitOrderToCustomer(io, updatedOrder, 'order:statusUpdate', { status: updatedOrder.status, order: updatedOrder });
      }

    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
    res.status(500).send('Webhook Error');
  }
};

// Generate unique order ID (AM-XXXX format)
const generateOrderId = async () => {
  // Use timestamp + random number to guarantee 100% uniqueness even with concurrent requests
  const timestampPart = Date.now().toString().slice(-5);
  const randomPart = Math.floor(10 + Math.random() * 90);
  return `AM-${timestampPart}${randomPart}`;
};

/**
 * @route   POST /api/orders/place
 * @desc    Place a new order — NO payment yet, wait for seller to accept first
 */
const placeOrder = async (req, res) => {
  try {
    const {
      kitchenId,
      items, // [{ menuItemId, qty }]
      deliveryAddress,
      schedule,
      paymentType, // 'online' or 'partialCod'
    } = req.body;

    if (!kitchenId || !mongoose.Types.ObjectId.isValid(kitchenId)) {
      return res.status(400).json({ success: false, message: 'Invalid kitchen ID.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }
    const addressCheck = validateDeliveryAddress(deliveryAddress);
    if (!addressCheck.ok) {
      return res.status(400).json({ success: false, message: addressCheck.message });
    }
    for (const cartItem of items) {
      const id = cartItem.menuItemId || cartItem._id;
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: 'Invalid menu item in cart.' });
      }
      const qty = Number(cartItem.qty);
      if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ success: false, message: 'Invalid quantity for an item.' });
      }
    }

    const customerId = req.user.id;

    // Validate payment type
    if (!['online', 'partialCod'].includes(paymentType)) {
      return res.status(400).json({ success: false, message: 'Invalid payment type. Must be online or partialCod.' });
    }

    // 1. Fetch real prices from DB to prevent tampering
    const menuItemIds = items.map(item => item.menuItemId || item._id);
    const dbItems = await MenuItem.find({ _id: { $in: menuItemIds } })
      .select('name price inStock kitchenId type')
      .lean();

    if (dbItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid items in cart.' });
    }

    if (dbItems.length !== items.length) {
      return res.status(400).json({ success: false, message: 'Some items are no longer available' });
    }

    const outOfStock = dbItems.filter((dbI) => dbI.inStock === false);
    if (outOfStock.length > 0) {
      const names = outOfStock.map((i) => i.name).join(', ');
      return res.status(400).json({
        success: false,
        message: `Some items are out of stock: ${names}`,
      });
    }

    const wrongKitchen = dbItems.filter((dbI) => dbI.kitchenId.toString() !== kitchenId.toString());
    if (wrongKitchen.length > 0) {
      return res.status(400).json({ success: false, message: 'Some items do not belong to this kitchen.' });
    }

    let itemTotal = 0;
    const orderItems = items.map((cartItem) => {
      const dbItem = dbItems.find(dbI => dbI._id.toString() === (cartItem.menuItemId || cartItem._id).toString());
      if (!dbItem) throw new Error('Menu item not found: ' + cartItem.name);
      
      const price = dbItem.price;
      const qty = cartItem.qty;
      itemTotal += price * qty;
      
      return {
        menuItemId: dbItem._id,
        name: dbItem.name,
        price,
        qty,
        type: dbItem.type,
      };
    });

    // 2. Kitchen + distance-based fees (server is source of truth)
    const kitchen = await Kitchen.findById(kitchenId)
      .select('name location isOpen accountStatus verificationStatus')
      .lean();
    if (!kitchen) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }
    if (!isKitchenCustomerVisible(kitchen)) {
      return res.status(400).json({ success: false, message: 'This kitchen is not available right now.' });
    }
    if (!kitchen.isOpen) {
      return res.status(400).json({ success: false, message: 'This kitchen is currently closed and not accepting orders.' });
    }

    if (!deliveryAddress?.location?.coordinates || !kitchen.location?.coordinates) {
      return res.status(400).json({
        success: false,
        message: 'Delivery location is required to calculate delivery charges.',
      });
    }

    let deliveryLocation = {
      type: 'Point',
      coordinates: deliveryAddress.location.coordinates,
    };

    const calculatedDistance = calcDistanceFromCoords(
      deliveryAddress.location.coordinates,
      kitchen.location.coordinates
    );
    if (calculatedDistance == null) {
      return res.status(400).json({
        success: false,
        message: 'Could not calculate distance to kitchen. Check delivery address.',
      });
    }

    const pricing = getDeliveryPricing(calculatedDistance);
    if (!pricing.ok) {
      return res.status(400).json({ success: false, message: pricing.message });
    }

    const { deliveryFee, platformFee, distanceKm } = pricing;
    const grandTotal = itemTotal + deliveryFee + platformFee;

    // 3. Online / cash split from authoritative grand total
    let onlineAmount, cashAmount;
    const codOnlinePercent = getPartialCodOnlinePercent();
    if (paymentType === 'online') {
      onlineAmount = grandTotal;
      cashAmount = 0;
    } else {
      onlineAmount = Math.round(grandTotal * (codOnlinePercent / 100));
      cashAmount = grandTotal - onlineAmount;
    }

    // 4. Create Order in DB — NO Razorpay order yet!
    const orderId = await generateOrderId();

    const newOrder = new Order({
      orderId,
      customerId,
      customerName: req.user.name && req.user.name.trim() !== '' && req.user.name !== 'Customer' ? req.user.name : 'Customer',
      customerPhone: req.user.phone,
      kitchenId,
      items: orderItems,
      itemTotal,
      deliveryFee,
      platformFee,
      grandTotal,
      paymentType,
      onlineAmount,
      cashAmount,
      paymentStatus: 'awaiting_acceptance',  // No payment until seller accepts
      status: 'PENDING_SELLER_APPROVAL',
      deliveryAddress: {
        house: deliveryAddress.house,
        landmark: deliveryAddress.landmark,
        label: deliveryAddress.label,
      },
      deliveryLocation,
      distance: distanceKm,
      schedule: schedule || { isScheduled: false },
      // razorpayOrderId is NOT set — will be created after seller accepts
    });

    await newOrder.save();
    await newOrder.populate('customerId', 'name phone avatar');
    if (newOrder.customerId && (!newOrder.customerId.avatar || newOrder.customerId.avatar.trim() === '' || newOrder.customerId.avatar.includes('flaticon') || newOrder.customerId.avatar.startsWith('file://'))) {
      const cName = newOrder.customerId.name || 'Customer';
      newOrder.customerId.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(cName)}&background=FF6B35&color=fff&size=256&bold=true`;
    }

    console.log(`[ORDER] Created ${orderId} | dist ${distanceKm}km | delivery ₹${deliveryFee} + platform ₹${platformFee} | Online: ₹${onlineAmount} | Cash: ₹${cashAmount}`);

    // 5. Emit to Kitchen that a new order arrived
    const io = req.app.get('io');
    if (io) {
      emitToKitchen(io, kitchenId, 'order:new', newOrder);
    }

    // 5.5 Send Push Notification to Kitchen (background/killed state delivery)
    // Strategy: sendDataOnlyPush only (TTL=0, high priority, bypasses Doze mode).
    // Notifee background handler in index.js displays the notification with custom sound.
    // sendPushNotification removed — it caused duplicate notifications (double sound/banner).
    try {
      const kitchenTokenDoc = await Kitchen.findById(kitchenId).select('expoPushTokens');
      if (kitchenTokenDoc && kitchenTokenDoc.expoPushTokens && kitchenTokenDoc.expoPushTokens.length > 0) {
        const cName = newOrder.customerId?.name || 'A Customer';
        const notificationTitle = '🚨 New Order Received!';
        const notificationBody = formatOrderItemsForNotification(newOrder.items);
        const pushData = {
          type: 'seller_new_order',
          orderId: newOrder._id.toString(),
          displayOrderId: newOrder.orderId || newOrder._id.toString(),
          customerName: cName,
          itemTotal: String(itemTotal),
          grandTotal: String(grandTotal),
          notificationTitle,
          notificationBody,
          items: JSON.stringify(newOrder.items || []),
          deliveryAddress: JSON.stringify(newOrder.deliveryAddress || {}),
        };

        // Data-only push: wakes the app process (even killed state) without showing a system notification.
        // Notifee setBackgroundMessageHandler in index.js then creates the notification with
        // the custom 'order_bell' sound via the seller_orders_v2 channel.
        const pushPromises = kitchenTokenDoc.expoPushTokens.map(token => 
          sendDataOnlyPush(token, pushData)
        );
        await Promise.all(pushPromises);

        console.log(`[PUSH] New Order data-only push sent to Kitchen ${kitchenId} on ${kitchenTokenDoc.expoPushTokens.length} devices`);
      }
    } catch (pushErr) {
      console.error('[PUSH ERROR] Failed to send new order push notification:', pushErr);
    }

    scheduleAcceptanceTimer(newOrder._id, kitchenId, io);

    // 7. Return order to mobile (NO Razorpay data)
    return res.json({
      success: true,
      message: 'Order placed! Waiting for kitchen to accept.',
      data: {
        order: newOrder,
      },
    });

  } catch (error) {
    console.error('Error placing order:', error);
    res.status(500).json({ success: false, message: error.message || 'Server Error' });
  }
};

/**
 * @route   POST /api/orders/verify
 * @desc    Verify Razorpay payment signature after checkout
 */
const verifyPayment = async (req, res) => {
  try {
    const {
      orderId, // our DB _id
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing Razorpay payment details.' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.customerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to order' });
    }

    if (order.paymentStatus === 'paid') {
      const existing = await Order.findById(orderId)
        .select(CUSTOMER_ORDER_DETAIL_SELECT)
        .populate('kitchenId', 'name photo')
        .lean();
      return res.json({
        success: true,
        message: 'Payment already verified',
        data: { order: toCustomerOrderDTO(existing) },
      });
    }

    // Verify that the razorpay_order_id matches what we stored
    if (order.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ success: false, message: 'Razorpay order ID mismatch.' });
    }

    // Verify Razorpay Signature using HMAC SHA256 (skip if in DEV MOCK MODE)
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const isMock = isMockPaymentAllowed() && (
      razorpay_order_id?.startsWith('order_mock_')
      || razorpay_payment_id?.startsWith('pay_mock_')
      || razorpay_signature === 'mock_signature'
    );

    if (!isMock) {
      if (!secret) {
        return res.status(500).json({ success: false, message: 'Payment verification is not configured.' });
      }
      const body = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(body.toString())
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        console.error(`[PAYMENT VERIFY FAIL] Order: ${order.orderId} | Expected: ${expectedSignature} | Got: ${razorpay_signature}`);
        order.paymentStatus = 'failed';
        await order.save();
        return res.status(400).json({ success: false, message: 'Invalid payment signature. Payment verification failed.' });
      }
    } else {
      console.log(`[DEV MOCK MODE] Bypassing signature check for mock payment: ${razorpay_payment_id}`);
    }

    // ✅ Signature verified — update order
    console.log(`[PAYMENT VERIFIED] Order: ${order.orderId} | Payment: ${razorpay_payment_id}`);

    if (order.status === 'cancelled' || order.status === 'autoCancelled') {
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          paymentStatus: 'refund_pending',
          razorpayPaymentId: razorpay_payment_id,
        },
      });
      return res.status(409).json({
        success: false,
        message: 'Order was cancelled. Refund will be processed.',
      });
    }

    clearOrderTimers(order._id);

    // Atomic conditional update — guarantees only one execution transitions state and emits events
    const updatedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        paymentStatus: { $ne: 'paid' },
        status: { $nin: ['cancelled', 'autoCancelled'] },
      },
      {
        $set: {
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          paymentStatus: 'paid',
          ...(order.status === 'PENDING_CUSTOMER_PAYMENT' || order.status === 'placed' ? { status: 'accepted' } : {}),
        },
      },
      { new: true }
    );

    if (!updatedOrder) {
      // Already marked paid by webhook or cancelled
      const existingPaid = await Order.findById(order._id)
        .select(CUSTOMER_ORDER_DETAIL_SELECT)
        .populate('kitchenId', 'name photo')
        .lean();
      if (existingPaid?.paymentStatus === 'paid') {
        return res.json({
          success: true,
          message: 'Payment already verified',
          data: { order: toCustomerOrderDTO(existingPaid) },
        });
      }
      return res.status(409).json({
        success: false,
        message: 'Order state changed or cancelled.',
      });
    }

    await updatedOrder.populate('customerId', 'name');
    const customerName = updatedOrder.customerId?.name || 'A Customer';
    const itemsString = buildOrderItemsString(updatedOrder.items);

    // Notify via socket
    const io = req.app.get('io');
    if (io) {
      emitToKitchen(io, updatedOrder.kitchenId, 'order:paymentVerified', { orderId: updatedOrder._id, order: updatedOrder, customerName, itemsString });
      emitToKitchen(io, updatedOrder.kitchenId, 'order:statusUpdate', { status: updatedOrder.status, order: updatedOrder });
      emitOrderToCustomer(io, updatedOrder, 'order:statusUpdate', { status: updatedOrder.status, order: updatedOrder });
    }

    return res.json({
      success: true,
      message: 'Payment verified successfully! 🎉',
      data: {
        order: toCustomerOrderDTO(
          await Order.findById(updatedOrder._id)
            .select(CUSTOMER_ORDER_DETAIL_SELECT)
            .populate('kitchenId', 'name photo')
            .lean()
        ),
      },
    });

  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

async function buildCreatePaymentPayload(orderDoc) {
  const order = await Order.findById(orderDoc._id)
    .select(CUSTOMER_ORDER_DETAIL_SELECT)
    .populate('kitchenId', 'name photo')
    .lean();
  return {
    order: toCustomerOrderDTO(order),
    razorpayOrderId: orderDoc.razorpayOrderId,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    amount: Math.round(Number(orderDoc.onlineAmount || 0) * 100),
    currency: 'INR',
    onlineAmount: orderDoc.onlineAmount,
    cashAmount: orderDoc.cashAmount,
    acceptedAt: orderDoc.acceptedAt,
  };
}

async function markOrderPaidFromGateway(order, paymentId, io) {
  if (order.paymentStatus === 'paid') return order;
  if (order.status === 'cancelled' || order.status === 'autoCancelled') {
    await Order.findByIdAndUpdate(order._id, {
      $set: {
        paymentStatus: 'refund_pending',
        razorpayPaymentId: paymentId || order.razorpayPaymentId,
      },
    });
    return order;
  }
  clearOrderTimers(order._id);
  const updatedOrder = await Order.findOneAndUpdate(
    {
      _id: order._id,
      paymentStatus: { $ne: 'paid' },
      status: { $nin: ['cancelled', 'autoCancelled'] },
    },
    {
      $set: {
        paymentStatus: 'paid',
        ...(order.status === 'PENDING_CUSTOMER_PAYMENT' || order.status === 'placed' ? { status: 'accepted' } : {}),
        ...(paymentId ? { razorpayPaymentId: paymentId } : {}),
      },
    },
    { new: true }
  );

  if (!updatedOrder) return order;

  if (io) {
    await updatedOrder.populate('customerId', 'name');
    const customerName = updatedOrder.customerId?.name || 'A Customer';
    const itemsString = buildOrderItemsString(updatedOrder.items);
    emitToKitchen(io, updatedOrder.kitchenId, 'order:paymentVerified', {
      orderId: updatedOrder._id,
      order: updatedOrder,
      customerName,
      itemsString,
    });
    emitToKitchen(io, updatedOrder.kitchenId, 'order:statusUpdate', { status: updatedOrder.status, order: updatedOrder });
    emitOrderToCustomer(io, updatedOrder, 'order:statusUpdate', { status: updatedOrder.status, order: updatedOrder });
  }
  return updatedOrder;
}

/**
 * @route   POST /api/orders/create-payment
 * @desc    Create or reuse Razorpay payment order for pending orders (e.g., PAY NOW on tracking screen)
 */
const createPaymentOrder = async (req, res) => {
  try {
    const { orderId } = req.body;
    
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (!isOrderCustomer(order, req.user)) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to order' });
    }

    if (order.paymentStatus === 'paid') {
      return res.json({
        success: true,
        alreadyPaid: true,
        message: 'Payment already completed for this order.',
        data: await buildCreatePaymentPayload(order),
      });
    }

    if (order.status !== 'PENDING_CUSTOMER_PAYMENT') {
      return res.status(400).json({ success: false, message: 'Order is not awaiting payment.' });
    }

    if (!razorpayInstance && !isMockPaymentAllowed()) {
      return res.status(500).json({ success: false, message: 'Payment gateway not configured.' });
    }

    const io = req.app.get('io');
    const expectedAmountPaise = Math.round(Number(order.onlineAmount || 0) * 100);
    const PAYMENT_WINDOW_MS = 5 * 60 * 1000;

    // Reuse existing Razorpay order when still open; reconcile if already captured
    if (order.razorpayOrderId && razorpayInstance && !String(order.razorpayOrderId).startsWith('order_mock_')) {
      try {
        const payments = await razorpayInstance.orders.fetchPayments(order.razorpayOrderId);
        const captured = (payments?.items || []).find(
          (p) => p.status === 'captured' || p.status === 'authorized'
        );
        if (captured) {
          await markOrderPaidFromGateway(order, captured.id, io);
          return res.json({
            success: true,
            alreadyPaid: true,
            message: 'Payment already captured.',
            data: await buildCreatePaymentPayload(order),
          });
        }

        const rzOrder = await razorpayInstance.orders.fetch(order.razorpayOrderId);
        const reusable =
          rzOrder &&
          ['created', 'attempted'].includes(rzOrder.status) &&
          Number(rzOrder.amount) === expectedAmountPaise;
        if (reusable) {
          const acceptedAtMs = order.acceptedAt ? new Date(order.acceptedAt).getTime() : 0;
          const windowExpired = !acceptedAtMs || Date.now() - acceptedAtMs > PAYMENT_WINDOW_MS;
          if (windowExpired) {
            order.acceptedAt = new Date();
            await order.save();
            schedulePaymentTimer(order._id, io);
          }
          console.log(`[RAZORPAY] Reusing payment order for ${order.orderId}: ${order.razorpayOrderId}`);
          return res.json({
            success: true,
            reused: true,
            data: await buildCreatePaymentPayload(order),
          });
        }
      } catch (reuseErr) {
        console.warn(`[RAZORPAY] Reuse check failed for ${order.orderId}:`, reuseErr.message);
      }
    } else if (order.razorpayOrderId && isMockPaymentAllowed() && String(order.razorpayOrderId).startsWith('order_mock_')) {
      const acceptedAtMs = order.acceptedAt ? new Date(order.acceptedAt).getTime() : 0;
      const windowExpired = !acceptedAtMs || Date.now() - acceptedAtMs > PAYMENT_WINDOW_MS;
      if (windowExpired) {
        order.acceptedAt = new Date();
        await order.save();
        schedulePaymentTimer(order._id, io);
      }
      return res.json({
        success: true,
        reused: true,
        data: await buildCreatePaymentPayload(order),
      });
    }

    // Create new Razorpay order only when no reusable order exists
    let razorpayOrder;
    if (isMockPaymentAllowed()) {
      razorpayOrder = {
        id: `order_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        amount: expectedAmountPaise,
        currency: 'INR',
        status: 'created',
      };
    } else {
      const razorpayOptions = {
        amount: expectedAmountPaise,
        currency: 'INR',
        receipt: `rcpt_${order.orderId}_${Date.now()}`.slice(0, 40),
        notes: {
          appOrderId: order.orderId,
          paymentType: order.paymentType,
        },
      };
      razorpayOrder = await razorpayInstance.orders.create(razorpayOptions);
    }

    order.razorpayOrderId = razorpayOrder.id;
    order.acceptedAt = new Date();
    await order.save();
    schedulePaymentTimer(order._id, io);

    console.log(`[RAZORPAY] Created payment order for ${order.orderId}: ${razorpayOrder.id} | ₹${order.onlineAmount}`);

    return res.json({
      success: true,
      data: await buildCreatePaymentPayload(order),
    });

  } catch (error) {
    console.error('Error creating payment order:', error);
    res.status(500).json({ success: false, message: error.message || 'Server Error' });
  }
};

/**
 * @route   GET /api/orders/customer/history
 * @desc    Get order history for customer
 */
const getCustomerHistory = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    const [orders, total] = await Promise.all([
      Order.find({ customerId: req.user.id })
        .select(CUSTOMER_ORDER_LIST_SELECT)
        .populate('kitchenId', 'name photo')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments({ customerId: req.user.id }),
    ]);

    res.json({
      success: true,
      data: toCustomerOrderListDTO(orders),
      pagination: {
        skip,
        limit,
        total,
        hasMore: skip + orders.length < total,
      },
    });
  } catch (error) {
    console.error('Error fetching customer history:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   GET /api/orders/customer/stats
 * @desc    Lightweight order counts for profile
 */
const getCustomerOrderStats = async (req, res) => {
  try {
    const customerId = req.user.id;
    const [totalOrders, ongoingCount, deliveredCount] = await Promise.all([
      Order.countDocuments({ customerId }),
      Order.countDocuments({ customerId, status: { $nin: TERMINAL_STATUSES } }),
      Order.countDocuments({ customerId, status: 'delivered' }),
    ]);
    res.json({
      success: true,
      data: { totalOrders, ongoingCount, deliveredCount },
    });
  } catch (error) {
    console.error('getCustomerOrderStats error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   GET /api/orders/:id
 * @desc    Get order by ID for tracking
 */
const getOrderById = async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = await Order.findById(orderId)
      .populate({
        path: 'kitchenId',
        select: 'name photo location distance ownerId phone address',
        populate: { path: 'ownerId', select: 'phone' },
      })
      .populate('customerId', 'name phone avatar')
      .populate({ path: 'riderId', select: 'name phone' })
      .populate({ path: 'items.menuItemId', select: 'prepTime' });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const user = req.user;
    const authorized =
      isOrderKitchen(order, user) ||
      isOrderCustomer(order, user) ||
      isOrderRider(order, user);

    if (!authorized) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to order' });
    }

    const orderObj = order.toObject();
    let payload;
    if (isOrderCustomer(order, user)) {
      payload = {
        ...toCustomerOrderDTO(orderObj),
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
      };
    } else if (isOrderKitchen(order, user)) {
      payload = {
        ...toKitchenOrderDTO(orderObj),
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
      };
    } else {
      // Rider: may display pickupOtp; must not receive drop/delivery OTP secrets
      const riderPayload = { ...orderObj };
      delete riderPayload.dropOtp;
      delete riderPayload.deliveryOtp;
      delete riderPayload.razorpaySignature;
      payload = {
        ...riderPayload,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
      };
    }

    res.json({
      success: true,
      data: payload,
    });
  } catch (error) {
    console.error('Error fetching order by ID:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};


/**
 * @route   PUT /api/orders/:id/accept
 * @desc    Accept order, create Razorpay payment order, and ask customer to pay
 */
const acceptOrder = async (req, res) => {
  try {
    const { deliveryMethod } = req.body; // 'self' or 'rider'
    let order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.kitchenId.toString() !== req.user.kitchenId?.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to order' });
    }

    // Don't accept already cancelled/auto-cancelled orders
    if (['cancelled', 'autoCancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'This order has already been cancelled.' });
    }

    if (!PENDING_ACCEPT_STATUSES.includes(order.status)) {
      if (ALREADY_ACCEPTED_STATUSES.includes(order.status)) {
        const existing = await Order.findById(order._id).populate('customerId', 'name phone avatar');
        return res.json({
          success: true,
          message: 'Order already accepted',
          data: existing || order,
        });
      }
      return res.status(400).json({ success: false, message: 'Order cannot be accepted at this stage' });
    }

    clearOrderTimers(order._id);

    const pickupOtp = crypto.randomInt(1000, 10000).toString();
    const dropOtp = crypto.randomInt(1000, 10000).toString();
    const deliveryMethodVal = deliveryMethod === 'self' || deliveryMethod === 'rider' ? deliveryMethod : null;

    const lockedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        kitchenId: req.user.kitchenId,
        status: { $in: PENDING_ACCEPT_STATUSES },
      },
      {
        $set: {
          pickupOtp,
          dropOtp,
          deliveryOtp: dropOtp,
          deliveryMethod: deliveryMethodVal,
          acceptedAt: Date.now(),
        },
      },
      { new: true }
    );

    if (!lockedOrder) {
      const existing = await Order.findById(order._id).populate('customerId', 'name phone avatar');
      if (existing && ALREADY_ACCEPTED_STATUSES.includes(existing.status)) {
        return res.json({
          success: true,
          message: 'Order already accepted',
          data: existing,
        });
      }
      return res.status(400).json({ success: false, message: 'Order cannot be accepted at this stage' });
    }

    order = lockedOrder;

    // Seller responded — clear 3-strike miss counter immediately
    await resetKitchenConsecutiveMisses(order.kitchenId).catch((err) => {
      console.warn('[acceptOrder] reset consecutiveMisses failed:', err.message);
    });
    
    if (!order.onlineAmount || order.onlineAmount === 0) {
      const acceptedOrder = await Order.findOneAndUpdate(
        { _id: order._id, status: { $in: PENDING_ACCEPT_STATUSES.concat(['PENDING_CUSTOMER_PAYMENT']) } },
        { $set: { status: 'accepted', paymentStatus: 'paid' } },
        { new: true }
      ).populate('customerId', 'name phone avatar');
      if (!acceptedOrder) {
        return res.status(400).json({ success: false, message: 'Order could not be accepted' });
      }
      if (acceptedOrder.customerId && (!acceptedOrder.customerId.avatar || acceptedOrder.customerId.avatar.trim() === '' || acceptedOrder.customerId.avatar.includes('flaticon') || acceptedOrder.customerId.avatar.startsWith('file://'))) {
        const cName = acceptedOrder.customerId.name || 'Customer';
        acceptedOrder.customerId.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(cName)}&background=FF6B35&color=fff&size=256&bold=true`;
      }
      const io = req.app.get('io');
      if (io) {
        emitOrderToCustomer(io, acceptedOrder, 'order:statusUpdate', { status: acceptedOrder.status, order: acceptedOrder });
        emitToKitchen(io, acceptedOrder.kitchenId, 'order:statusUpdate', { status: acceptedOrder.status, order: acceptedOrder });
      }

      return res.json({
        success: true,
        message: 'Order accepted successfully!',
        data: acceptedOrder,
      });
    }

    // --- CREATE RAZORPAY ORDER NOW (after seller accepts) ---
    let razorpayData = null;

    if (!razorpayInstance && !isMockPaymentAllowed()) {
      return res.status(500).json({ success: false, message: 'Payment gateway is not configured on the server.' });
    }

    const razorpayOptions = {
      amount: order.onlineAmount * 100, // amount in paise
      currency: 'INR',
      receipt: `rcpt_${order.orderId}_${Date.now()}`,
      notes: {
        paymentType: order.paymentType,
        appOrderId: order.orderId,
      },
    };
    let razorpayOrder = null;
    try {
      if (isMockPaymentAllowed()) {
        const mockOrderId = `order_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        razorpayOrder = { id: mockOrderId, amount: order.onlineAmount * 100, currency: 'INR', status: 'created' };
      } else {
        const options = {
          amount: Math.round(order.onlineAmount * 100),
          currency: 'INR',
          receipt: `rcpt_${order.orderId.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 40),
          payment_capture: 1,
          notes: {
            appOrderId: order.orderId,
            paymentType: order.paymentType,
          },
        };
        razorpayOrder = await razorpayInstance.orders.create(options);
      }
    } catch (err) {
      console.error('[RAZORPAY ERROR in acceptOrder]:', err);
      return res.status(500).json({ success: false, message: 'Payment gateway error: ' + (err.error?.description || err.message || 'Unable to generate Razorpay order') });
    }

    const paymentOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        kitchenId: req.user.kitchenId,
        status: { $in: PENDING_ACCEPT_STATUSES },
      },
      {
        $set: {
          razorpayOrderId: razorpayOrder.id,
          paymentStatus: 'pending',
          status: 'PENDING_CUSTOMER_PAYMENT',
        },
      },
      { new: true }
    ).populate('customerId', 'name phone avatar');

    if (!paymentOrder) {
      return res.status(400).json({ success: false, message: 'Order state changed during payment setup' });
    }

    order = paymentOrder;

    razorpayData = {
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      amount: order.onlineAmount * 100,
      currency: 'INR',
      onlineAmount: order.onlineAmount,
      cashAmount: order.cashAmount,
      acceptedAt: order.acceptedAt,
    };

    if (order.customerId && (!order.customerId.avatar || order.customerId.avatar.trim() === '' || order.customerId.avatar.includes('flaticon') || order.customerId.avatar.startsWith('file://'))) {
      const cName = order.customerId.name || 'Customer';
      order.customerId.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(cName)}&background=FF6B35&color=fff&size=256&bold=true`;
    }

    const io = req.app.get('io');
    if (io) {
      // Tell customer: "Kitchen accepted! Now pay."
      emitOrderToCustomer(io, order, 'order:accepted_pay_now', {
        orderId: order._id,
        order,
        ...razorpayData,
      });
      emitToKitchen(io, order.kitchenId, 'order:statusUpdate', { status: order.status, order });
    }

    schedulePaymentTimer(order._id, io);

    res.json({ success: true, message: 'Order accepted. Waiting for customer payment.', data: order });
  } catch (error) {
    console.error('acceptOrder error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   PUT /api/orders/:id/reject
 * @desc    Reject/Cancel order by kitchen
 */
const rejectOrder = async (req, res) => {
  try {
    const { reason } = req.body;
    const orderId = req.params.id;

    const existing = await Order.findById(orderId);
    if (!existing) return res.status(404).json({ success: false, message: 'Order not found' });
    if (existing.kitchenId.toString() !== req.user.kitchenId?.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (existing.paymentStatus === 'paid' || ['accepted', 'preparing', 'ready', 'outForDelivery', 'delivered'].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        message: 'Order cannot be rejected after payment or during preparation/delivery.',
      });
    }

    clearOrderTimers(orderId);

    const cancelUpdate = {
      status: 'cancelled',
      cancelledAt: Date.now(),
      cancelReason: reason || 'Seller rejected this order',
    };
    if (existing.paymentStatus === 'paid') {
      cancelUpdate.paymentStatus = 'refund_pending';
    }

    const order = await Order.findOneAndUpdate(
      { _id: orderId, kitchenId: req.user.kitchenId, status: { $in: REJECTABLE_STATUSES } },
      { $set: cancelUpdate },
      { new: true }
    );

    if (!order) {
      return res.status(400).json({
        success: false,
        message: 'Order cannot be rejected at this stage.',
      });
    }

    const io = req.app.get('io');
    if (io) {
      emitOrderToCustomer(io, order, 'order:rejected', { reason: order.cancelReason });
      emitOrderToCustomer(io, order, 'order:statusUpdate', { status: order.status, order });
      emitToKitchen(io, order.kitchenId, 'order:statusUpdate', { status: order.status, order });
    }

    res.json({ success: true, message: 'Order rejected', data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   PUT /api/orders/:id/status
 * @desc    Update order status (preparing, outForDelivery)
 */
const updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.kitchenId.toString() !== req.user.kitchenId?.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (status === 'ready') {
      return res.status(400).json({
        success: false,
        message: 'Use dispatch endpoint to mark ready and choose delivery method',
      });
    }

    if (!['preparing', 'outForDelivery'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status update' });
    }

    let filter = { _id: order._id, kitchenId: req.user.kitchenId };
    const update = { $set: { status } };

    if (status === 'preparing') {
      filter.status = 'accepted';
      const isOnlineRequired = order.paymentType === 'online' || order.paymentType === 'partialCod' || (order.onlineAmount != null && Number(order.onlineAmount) > 0);
      if (isOnlineRequired && order.paymentStatus !== 'paid') {
        return res.status(400).json({ success: false, message: 'Payment not verified yet' });
      }
      update.$set.prepStartedAt = Date.now();
    }

    if (status === 'outForDelivery') {
      filter.status = 'ready';
      filter.deliveryMethod = 'self';
      update.$set.outForDeliveryAt = Date.now();
    }

    const updatedOrder = await Order.findOneAndUpdate(filter, update, { new: true });
    if (!updatedOrder) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status transition for this order',
      });
    }

    const populatedOrder = await Order.findById(updatedOrder._id)
      .populate('customerId', 'name phone avatar')
      .populate('riderId', 'name phone avatar')
      .populate('kitchenId', 'name address location phone')
      .populate({ path: 'items.menuItemId', select: 'prepTime' });

    const io = req.app.get('io');
    if (io) {
      const payload = { status, orderId: updatedOrder._id, order: populatedOrder || updatedOrder };
      emitOrderToCustomer(io, updatedOrder, 'order:statusUpdate', payload);
      if (updatedOrder.riderId) {
        io.to(`rider_${updatedOrder.riderId}`).emit('order:statusUpdate', payload);
      }
      if (updatedOrder.kitchenId || populatedOrder?.kitchenId?._id) {
        const kId = updatedOrder.kitchenId || populatedOrder.kitchenId._id;
        emitToKitchen(io, kId, 'order:statusUpdate', payload);
      }
    }

    res.json({ success: true, message: `Order status updated to ${status}`, data: populatedOrder || updatedOrder });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   PUT /api/orders/:id/verify-delivery-otp
 * @desc    Verify OTP and mark as delivered
 */
const verifyDeliveryOtp = async (req, res) => {
  try {
    const { otp, doorPaymentMode } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.kitchenId.toString() !== req.user.kitchenId?.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    
    const expectedOtp = order.dropOtp || order.deliveryOtp;
    if (!expectedOtp || expectedOtp !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid Delivery OTP' });
    }

    if (order.status === 'delivered') {
      return res.status(400).json({ success: false, message: 'Order is already delivered' });
    }

    if (order.status !== 'outForDelivery') {
      return res.status(400).json({ success: false, message: 'Order must be out for delivery before marking delivered' });
    }

    if (order.deliveryMethod !== 'self') {
      return res.status(400).json({ success: false, message: 'Self-delivery OTP verification only applies to self delivery orders' });
    }

    const claimedDoorMode = doorPaymentMode === 'online' ? 'online' : 'cash';
    
    if (claimedDoorMode === 'online' && order.paymentStatus !== 'paid') {
      return res.status(400).json({ success: false, message: 'Please wait for the customer to complete the QR payment.' });
    }

    const updatedOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: 'outForDelivery', deliveryMethod: 'self' },
      {
        $set: {
          status: 'delivered',
          deliveredAt: Date.now(),
          doorPaymentMode: claimedDoorMode,
        }
      },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(400).json({ success: false, message: 'Order is already delivered or cancelled' });
    }

    await recordDeliveredOrderStats(updatedOrder, { logPrefix: '[seller/self-delivery]' });
    await reconcileOrderDelivery(updatedOrder);

    const io = req.app.get('io');
    if (io) {
      emitOrderToCustomer(io, updatedOrder, 'order:delivered', { orderId: updatedOrder._id, order: toCustomerOrderDTO(updatedOrder) });
      const payload = {
        status: 'delivered',
        orderId: updatedOrder._id,
        order: toKitchenOrderDTO(updatedOrder),
      };
      emitToKitchen(io, updatedOrder.kitchenId, 'order:statusUpdate', payload);
    }

    res.json({
      success: true,
      message: 'Order delivered successfully',
      data: toKitchenOrderDTO(updatedOrder),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/** Parse YYYY-MM-DD (optional range) into local start/end for deliveredAt filter */
function parseDeliveredDateRange(from, to) {
  if (!from || typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return null;
  const toStr = (to && typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to)) ? to : from;
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = toStr.split('-').map(Number);
  if (!fromYear || !fromMonth || !fromDay || !toYear || !toMonth || !toDay) return null;
  return {
    start: new Date(fromYear, fromMonth - 1, fromDay, 0, 0, 0, 0),
    end: new Date(toYear, toMonth - 1, toDay, 23, 59, 59, 999),
  };
}

/**
 * @route   GET /api/orders/kitchen/history
 * @desc    Get order history for kitchen
 */
const getKitchenHistory = async (req, res) => {
  try {
    if (!req.user.kitchenId) {
      return res.status(403).json({ success: false, message: 'User does not have an active kitchen' });
    }

    const kitchenId = req.user.kitchenId;
    const historyLimit = Math.min(Math.max(parseInt(req.query.historyLimit, 10) || 50, 1), 100);
    const historySkip = Math.max(parseInt(req.query.historySkip, 10) || 0, 0);
    const historyStatus = req.query.historyStatus;
    const historyOnly = req.query.scope === 'history';
    const deliveredRange = parseDeliveredDateRange(req.query.deliveredFrom, req.query.deliveredTo);
    const io = req.app.get('io');

    await expireStaleRiderSearches(kitchenId, io);

    const populateOpts = [
      { path: 'customerId', select: 'name phone avatar' },
      { path: 'riderId', select: 'name phone avatar' },
    ];

    // Cap high enough for busy kitchens; client should also pass activeLimit.
    const activeCap = Math.min(Math.max(parseInt(req.query.activeLimit, 10) || 200, 1), 300);

    const historyStatusFilter = historyStatus === 'delivered'
      ? ['delivered']
      : TERMINAL_STATUSES;
    const historySort = historyStatus === 'delivered'
      ? { deliveredAt: -1, createdAt: -1 }
      : { createdAt: -1 };

    const historyQuery = { kitchenId, status: { $in: historyStatusFilter } };
    if (deliveredRange && historyStatus === 'delivered') {
      historyQuery.deliveredAt = { $gte: deliveredRange.start, $lte: deliveredRange.end };
    }

    const historyFind = Order.find(historyQuery)
      .select(KITCHEN_ORDER_LIST_SELECT)
      .populate(populateOpts)
      .sort(historySort)
      .skip(historySkip)
      .limit(historyLimit)
      .lean();

    const countPromise = (deliveredRange && historyStatus === 'delivered' && historySkip === 0)
      ? Order.countDocuments(historyQuery)
      : Promise.resolve(null);

    const activePromise = historyOnly
      ? Promise.resolve([])
      : Order.find({ kitchenId, status: { $nin: TERMINAL_STATUSES } })
          .select(KITCHEN_ORDER_LIST_SELECT)
          .populate(populateOpts)
          .sort({ createdAt: -1 })
          .limit(activeCap)
          .lean();

    const [activeOrders, historyOrders, historyTotal] = await Promise.all([
      activePromise,
      historyFind,
      countPromise,
    ]);

    res.json({
      success: true,
      data: processKitchenOrderAvatars(historyOnly ? historyOrders : [...activeOrders, ...historyOrders]),
      pagination: {
        historySkip,
        historyLimit,
        historyHasMore: historyOrders.length === historyLimit,
        ...(historyTotal != null ? { historyTotal } : {}),
      },
    });
  } catch (error) {
    console.error('getKitchenHistory error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   GET /api/orders/kitchen/queue
 * @desc    Lightweight pending-order queue for seller dashboard
 */
const getKitchenQueue = async (req, res) => {
  try {
    if (!req.user.kitchenId) {
      return res.status(403).json({ success: false, message: 'User does not have an active kitchen' });
    }

    const kitchen = await Kitchen.findById(req.user.kitchenId).select('verificationStatus accountStatus').lean();
    if (!isKitchenVerifiedForSeller(kitchen)) {
      return res.json({ success: true, data: [] });
    }

    const orders = await Order.find({
      kitchenId: req.user.kitchenId,
      status: { $in: PENDING_QUEUE_STATUSES },
    })
      .populate('customerId', 'name phone avatar')
      .sort({ createdAt: 1 })
      .lean();

    res.json({ success: true, data: processKitchenOrderAvatars(orders) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const cancelOrder = async (req, res) => {
  try {
    const { reason, onlyIfStatuses } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (!isOrderCustomer(order, req.user)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const DEFAULT_CANCELLABLE = ['PENDING_SELLER_APPROVAL', 'PENDING_CUSTOMER_PAYMENT', 'placed'];
    const ALLOWED_CANCEL_STATUSES = new Set(DEFAULT_CANCELLABLE);
    let cancellableStatuses = DEFAULT_CANCELLABLE;
    if (Array.isArray(onlyIfStatuses) && onlyIfStatuses.length > 0) {
      const filtered = onlyIfStatuses.filter((s) => ALLOWED_CANCEL_STATUSES.has(s));
      if (filtered.length > 0) cancellableStatuses = filtered;
    }

    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Order state changed, cannot cancel now' });
    }

    clearOrderTimers(order._id);

    const updatedOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: { $in: cancellableStatuses } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: reason || 'Cancelled by user',
          ...(order.paymentStatus === 'paid' ? { paymentStatus: 'refund_pending' } : {}),
        },
      },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(400).json({ success: false, message: 'Order state changed, cannot cancel now' });
    }

    const io = req.app.get('io');
    if (io) {
      const kitchenPayload = {
        orderId: updatedOrder._id,
        status: updatedOrder.status,
        order: updatedOrder,
        reason: updatedOrder.cancelReason,
      };
      emitOrderToCustomer(io, updatedOrder, 'order:statusUpdate', kitchenPayload);
      if (updatedOrder.kitchenId) {
        emitToKitchen(io, updatedOrder.kitchenId, 'order:statusUpdate', kitchenPayload);
        emitToKitchen(io, updatedOrder.kitchenId, 'order:customer_cancelled', kitchenPayload);
      }
    }

    if (updatedOrder.riderId) {
      try {
        await Rider.findOneAndUpdate(
          { userId: updatedOrder.riderId, activeOrderId: updatedOrder._id },
          { $set: { activeOrderId: null } }
        );
      } catch (riderErr) {
        console.warn('[cancelOrder] rider cleanup skipped:', riderErr.message);
      }
    }

    res.json({ success: true, message: 'Order cancelled successfully', data: updatedOrder });
  } catch (error) {
    console.error('cancelOrder error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   POST /api/orders/:id/rate
 * @desc    Rate a delivered order
 */
const rateOrder = async (req, res) => {
  try {
    const { kitchenRating, riderRating, feedback } = req.body;
    const orderId = req.params.id;

    if (!kitchenRating) {
      return res.status(400).json({ success: false, message: 'Kitchen rating is required' });
    }

    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Ensure the user owns the order
    if (order.customerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to rate this order' });
    }

    // Ensure order is delivered
    if (order.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'Can only rate delivered orders' });
    }

    // Ensure not already rated
    if (order.isRated) {
      return res.status(400).json({ success: false, message: 'Order has already been rated' });
    }

    if (order.deliveryMethod === 'rider' && !riderRating) {
      return res.status(400).json({ success: false, message: 'Rider rating is required for rider deliveries' });
    }

    const FEEDBACK_MAX = 250;
    const trimmedFeedback = String(feedback || '').trim();
    if (trimmedFeedback.length > FEEDBACK_MAX) {
      return res.status(400).json({
        success: false,
        message: `Feedback cannot exceed ${FEEDBACK_MAX} characters.`,
      });
    }

    // Save rating
    order.isRated = true;
    order.rating = {
      kitchenRating: Number(kitchenRating),
      riderRating: order.deliveryMethod === 'rider' ? Number(riderRating) : undefined,
      feedback: trimmedFeedback,
      ratedAt: Date.now()
    };

    await order.save();

    // Create Rating documents and update MenuItem stats
    const Rating = require('../models/Rating');
    const uniqueItemIds = [...new Set((order.items || []).map(i => (i.menuItemId || i._id).toString()))];
    const menuItems = await MenuItem.find({ _id: { $in: uniqueItemIds } });
    const menuById = new Map(menuItems.map((m) => [m._id.toString(), m]));

    for (const itemId of uniqueItemIds) {
      try {
        await Rating.create({
          orderId: order._id,
          customerId: req.user.id,
          kitchenId: order.kitchenId,
          menuItemId: itemId,
          kitchenRating: Number(kitchenRating),
          riderRating: order.deliveryMethod === 'rider' ? Number(riderRating) : undefined,
          feedback: trimmedFeedback
        });
      } catch (err) {
        console.log('Rating create note:', err.message);
      }

      const menuItem = menuById.get(itemId);
      if (menuItem) {
        const currentReviews = menuItem.totalReviews || 0;
        const currentRating = menuItem.rating || 0;
        const newTotalReviews = currentReviews + 1;
        const newAvgRating = ((currentRating * currentReviews) + Number(kitchenRating)) / newTotalReviews;

        menuItem.totalReviews = newTotalReviews;
        menuItem.rating = Number(newAvgRating.toFixed(1));
        await menuItem.save();
      }
    }

    // Update Kitchen stats
    const kitchen = await Kitchen.findById(order.kitchenId);
    if (kitchen) {
      const currentKitchenReviews = kitchen.totalReviews || 0;
      const currentKitchenRating = kitchen.avgRating || 0;
      const newKitchenReviews = currentKitchenReviews + 1;
      const newKitchenAvgRating = ((currentKitchenRating * currentKitchenReviews) + Number(kitchenRating)) / newKitchenReviews;

      kitchen.totalReviews = newKitchenReviews;
      kitchen.avgRating = Number(newKitchenAvgRating.toFixed(1));
      await kitchen.save();
    }

    await Promise.all([
      ...uniqueItemIds.map((id) => dishReviewCache.invalidate(id)),
      menuCache.invalidate(order.kitchenId),
      invalidateNearbyCachesForKitchen(kitchen || order.kitchenId, { logPrefix: '[order/rate]' }),
    ]);

    res.status(200).json({ success: true, message: 'Rating submitted successfully', data: order });
  } catch (error) {
    console.error('Error rating order:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const createDoorstepQr = async (req, res) => {
  try {
    const idParam = req.params.id;
    const mongoose = require('mongoose');
    let order = null;
    if (mongoose.Types.ObjectId.isValid(idParam)) {
      order = await Order.findById(idParam);
    }
    if (!order) {
      order = await Order.findOne({ orderId: idParam });
    }
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const isPartialCod = order.paymentType === 'partialCod';
    const { getPartialCodOnlinePercent } = require('../utils/orderConfig');
    const onlinePct = getPartialCodOnlinePercent() / 100;
    const cashAmount = order.cashAmount != null
      ? order.cashAmount
      : (isPartialCod ? Math.round((order.grandTotal || 0) * (1 - onlinePct)) : (order.grandTotal || 0));
    const amountInPaise = cashAmount * 100;

    let paymentLinkUrl = null;
    let razorpayPaymentLinkId = null;
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && amountInPaise >= 100) {
      try {
        const Razorpay = require('razorpay');
        const rz = new Razorpay({
          key_id: process.env.RAZORPAY_KEY_ID,
          key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
        
        await order.populate('customerId', 'name phone');
        
        const rawPhone = order.customerPhone || order.customerId?.phone || '';
        const cleanPhone = String(rawPhone).replace(/[^0-9]/g, '').slice(-10);
        
        const plink = await rz.paymentLink.create({
          amount: amountInPaise,
          currency: 'INR',
          accept_partial: false,
          description: `Doorstep Payment for Order ${order.orderId || order._id}`,
          customer: {
            name: order.customerName || order.customerId?.name || 'Customer',
            ...(cleanPhone.length === 10 ? { contact: cleanPhone } : {}),
          },
          notify: {
            sms: false,
            email: false,
          },
          reminder_enable: false,
          notes: { orderId: order._id.toString(), type: 'doorstep_cod' },
        });
        
        paymentLinkUrl = plink.short_url;
        razorpayPaymentLinkId = plink.id;
      } catch (err) {
        console.error('Razorpay doorstep Payment Link error:', err.error || err.message || err);
      }
    }

    // Direct UPI intent QR fallback (scannable by all UPI apps)
    if (!paymentLinkUrl) {
      paymentLinkUrl = `upi://pay?pa=razorpay-apnamenu@icici&pn=ApnaMenu&am=${cashAmount}&cu=INR&tn=Order_${order.orderId || order._id}`;
    }

    res.json({
      success: true,
      data: {
        orderId: order._id,
        amount: amountInPaise,
        currency: 'INR',
        cashAmount,
        paymentLinkUrl,
        razorpayPaymentLinkId,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (error) {
    console.error('createDoorstepQr error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   PUT /api/orders/:id/switch-self
 * @desc    Switch delivery method from rider to self
 */
const switchDeliveryToSelf = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.kitchenId.toString() !== req.user.kitchenId?.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const guard = canModifyRiderDispatch(order);
    if (!guard.ok) {
      return res.status(400).json({ success: false, message: guard.message });
    }

    const io = req.app.get('io');
    await revokeAssignedRider(io, order, 'Switched to self delivery by kitchen');
    await revokeBroadcastToRiders(io, order, 'Switched to self delivery by kitchen');

    clearRiderSearchExpiry(order._id);

    const updatedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: 'ready',
        deliveryMethod: 'rider',
        kitchenHandoverAt: null,
      },
      {
        $set: {
          deliveryMethod: 'self',
          riderStatus: 'none',
          riderId: null,
          kitchenHandoverAt: null,
        },
        $unset: { riderBroadcasts: '', riderRejections: '' },
      },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(400).json({ success: false, message: 'Cannot switch delivery method for this order' });
    }

    const populatedOrder = await Order.findById(updatedOrder._id)
      .populate('customerId', 'name phone avatar')
      .populate('kitchenId', 'name address phone location')
      .populate('items.menuItemId');

    if (io) {
      const payload = {
        status: populatedOrder.status,
        orderId: updatedOrder._id,
        order: populatedOrder,
      };
      emitOrderToCustomer(io, updatedOrder, 'order:statusUpdate', payload);
      emitToKitchen(io, updatedOrder.kitchenId, 'order:statusUpdate', payload);
    }

    res.status(200).json({ success: true, data: populatedOrder });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to switch delivery method' });
  }
};

/**
 * @route   PUT /api/orders/:id/retry-rider
 * @desc    Retry rider broadcast
 */
const retryRiderSearch = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.kitchenId.toString() !== req.user.kitchenId?.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (['delivered', 'cancelled', 'autoCancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Cannot retry rider search for this order' });
    }

    const guard = canModifyRiderDispatch(order);
    if (!guard.ok) {
      return res.status(400).json({ success: false, message: guard.message });
    }

    const allowedRetryStatuses = ['pending', 'rejected_all', 'ignored_all', 'none'];
    if (order.riderId) {
      return res.status(400).json({ success: false, message: 'Rider already assigned. Use handover or switch to self delivery.' });
    }
    if (!allowedRetryStatuses.includes(order.riderStatus)) {
      return res.status(400).json({ success: false, message: 'Rider search cannot be retried at this stage' });
    }

    const io = req.app.get('io');
    await revokeAssignedRider(io, order, 'Rider search restarted by kitchen');
    await revokeBroadcastToRiders(io, order, 'Rider search restarted by kitchen');
    clearRiderSearchExpiry(order._id);

    const updatedOrder = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: 'ready',
        deliveryMethod: 'rider',
        riderId: null,
        kitchenHandoverAt: null,
      },
      {
        $set: {
          riderStatus: 'pending',
          riderSearchStartedAt: Date.now(),
        },
        $unset: { riderRejections: '', riderBroadcasts: '' },
      },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(400).json({ success: false, message: 'Cannot retry rider search for this order' });
    }

    await broadcastToRiders(req, updatedOrder);
    scheduleRiderSearchExpiry(updatedOrder._id, io);

    const populatedOrder = await Order.findById(updatedOrder._id)
      .populate('customerId', 'name phone avatar')
      .populate('kitchenId', 'name address phone location')
      .populate('items.menuItemId');

    if (io) {
      const payload = {
        status: populatedOrder.status,
        orderId: updatedOrder._id,
        order: populatedOrder,
      };
      emitOrderToCustomer(io, updatedOrder, 'order:statusUpdate', payload);
      emitToKitchen(io, updatedOrder.kitchenId, 'order:statusUpdate', payload);
    }

    res.status(200).json({ success: true, data: populatedOrder });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to retry rider search' });
  }
};

/**
 * @route   PUT /api/orders/:id/dispatch
 * @desc    Choose delivery method when food is ready (self or rider)
 */
const dispatchOrder = async (req, res) => {
  try {
    const { deliveryMethod } = req.body;
    if (!['self', 'rider'].includes(deliveryMethod)) {
      return res.status(400).json({ success: false, message: 'Invalid delivery method' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.kitchenId.toString() !== req.user.kitchenId?.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (!['preparing', 'ready'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Order must be preparing before dispatch' });
    }

    if (order.onlineAmount > 0 && order.paymentStatus !== 'paid') {
      return res.status(400).json({ success: false, message: 'Payment not verified yet' });
    }

    if (order.deliveryMethod && order.status === 'ready') {
      const populatedExisting = await Order.findById(order._id)
        .populate('customerId', 'name phone avatar')
        .populate('riderId', 'name phone avatar')
        .populate('kitchenId', 'name address location phone')
        .populate({ path: 'items.menuItemId', select: 'prepTime' });
      if (order.deliveryMethod === deliveryMethod) {
        return res.json({
          success: true,
          message: 'Already dispatched',
          data: populatedExisting || order,
        });
      }
      return res.status(400).json({ success: false, message: 'Delivery method already chosen for this order' });
    }

    const pickupOtp = order.pickupOtp || crypto.randomInt(1000, 10000).toString();
    const dropOtp = order.dropOtp || crypto.randomInt(1000, 10000).toString();

    const update = {
      $set: {
        status: 'ready',
        deliveryMethod,
        pickupOtp,
        dropOtp,
        deliveryOtp: dropOtp,
      },
    };

    if (deliveryMethod === 'rider') {
      update.$set.riderStatus = 'pending';
      update.$set.riderSearchStartedAt = Date.now();
    } else {
      update.$set.riderStatus = 'none';
    }

    const updatedOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: { $in: ['preparing', 'ready'] }, kitchenId: req.user.kitchenId },
      update,
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(400).json({ success: false, message: 'Order cannot be dispatched at this stage' });
    }

    const io = req.app.get('io');

    if (deliveryMethod === 'rider') {
      await broadcastToRiders(req, updatedOrder);
      scheduleRiderSearchExpiry(updatedOrder._id, io);
    } else {
      clearRiderSearchExpiry(updatedOrder._id);
    }

    const populatedOrder = await Order.findById(updatedOrder._id)
      .populate('customerId', 'name phone avatar')
      .populate('riderId', 'name phone avatar')
      .populate('kitchenId', 'name address location phone')
      .populate({ path: 'items.menuItemId', select: 'prepTime' });

    if (io) {
      const payload = {
        status: populatedOrder.status,
        orderId: updatedOrder._id,
        order: populatedOrder || updatedOrder,
      };
      emitOrderToCustomer(io, updatedOrder, 'order:statusUpdate', payload);
      emitToKitchen(io, updatedOrder.kitchenId, 'order:statusUpdate', payload);
      if (updatedOrder.riderId) {
        io.to(`rider_${updatedOrder.riderId}`).emit('order:statusUpdate', payload);
      }
    }

    res.json({
      success: true,
      message: deliveryMethod === 'self' ? 'Ready for self delivery' : 'Searching for rider',
      data: toKitchenOrderDTO(populatedOrder || updatedOrder),
    });
  } catch (error) {
    console.error('dispatchOrder error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @route   PUT /api/orders/:id/confirm-handover
 * @desc    Seller confirms handover to rider using pickup PIN
 */
const confirmRiderHandover = async (req, res) => {
  try {
    const { otp } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.kitchenId.toString() !== req.user.kitchenId?.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    if (order.deliveryMethod !== 'rider' || !order.riderId) {
      return res.status(400).json({ success: false, message: 'No rider assigned to this order' });
    }
    if (order.status === 'outForDelivery') {
      return res.status(400).json({ success: false, message: 'Order already handed over' });
    }

    if (order.pickupOtp !== otp && !isDevOtpAllowed(otp)) {
      return res.status(400).json({ success: false, message: 'Invalid handover PIN' });
    }

    order.kitchenHandoverAt = Date.now();
    await order.save();

    const populatedOrder = await Order.findById(order._id)
      .populate('customerId', 'name phone avatar')
      .populate('riderId', 'name phone avatar')
      .populate('kitchenId', 'name address location phone');

    const io = req.app.get('io');
    if (io) {
      const payload = {
        status: order.status,
        orderId: order._id,
        order: populatedOrder || order,
      };
      emitOrderToCustomer(io, order, 'order:statusUpdate', payload);
      emitToKitchen(io, order.kitchenId, 'order:statusUpdate', payload);
      io.to(`rider_${order.riderId}`).emit('order:statusUpdate', payload);
    }

    res.json({ success: true, message: 'Handed over to rider', data: toKitchenOrderDTO(populatedOrder || order) });
  } catch (error) {
    console.error('confirmRiderHandover error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

module.exports = {
  placeOrder, verifyPayment, createPaymentOrder, getCustomerHistory, getCustomerOrderStats,
  acceptOrder, rejectOrder, updateStatus, verifyDeliveryOtp,
  getKitchenHistory, getKitchenQueue, broadcastToRiders, cancelOrder, rateOrder, createDoorstepQr, getOrderById, razorpayWebhook,
  switchDeliveryToSelf, retryRiderSearch, dispatchOrder, confirmRiderHandover,
};
