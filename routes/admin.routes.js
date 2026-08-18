const express = require('express');
const router = express.Router();
const {
  login,
  getMe,
  getDashboardStats,
  getDashboardRevenue,
  getPendingWithdrawals,
  approveWithdrawal,
  getWithdrawalHistory,
  getTransactions,
  getRiderDeposits,
  getUsers,
  getUserById,
  warnUser,
  suspendUser,
  unsuspendUser,
  deleteUser,
  getKitchens,
  getKitchenDetails,
  warnKitchen,
  suspendKitchen,
  unsuspendKitchen,
  deleteKitchen,
  approveKitchen,
  rejectKitchen,
  getRiders,
  getRiderById,
  warnRider,
  suspendRider,
  unsuspendRider,
  getOrders,
  forceCancelOrder,
  refundOrder,
  getDeletionRequests,
  resolveDeletionRequest,
} = require('../controllers/admin.controller');
const {
  sendNotification,
  getAllNotifications,
  deleteNotification,
} = require('../controllers/notification.controller');
const { adminProtect, superAdminOnly } = require('../middleware/adminAuth');
const { adminLoginLimiter } = require('../middleware/rateLimiter');

// Public auth route — strict rate limited
router.post('/login', adminLoginLimiter, login);

// Protected admin routes
router.use(adminProtect);

router.get('/me', getMe);

// Dashboard
router.get('/dashboard/stats', getDashboardStats);
router.get('/dashboard/revenue', getDashboardRevenue);

// Finance & Payouts
router.get('/withdrawals/pending', getPendingWithdrawals);
router.put('/withdrawals/:id/approve', approveWithdrawal);
router.get('/withdrawals/history', getWithdrawalHistory);
router.get('/deposits', getRiderDeposits);
router.get('/transactions', getTransactions);

// User Management
router.get('/users', getUsers);
router.get('/users/:id', getUserById);
router.post('/users/:id/warn', warnUser);
router.put('/users/:id/suspend', suspendUser);
router.put('/users/:id/unblock', unsuspendUser);
router.delete('/users/:id', superAdminOnly, deleteUser);

// Account Deletion Requests
router.get('/deletions', getDeletionRequests);
router.post('/deletions/:id/resolve', superAdminOnly, resolveDeletionRequest);

// Kitchen Management
router.get('/kitchens', getKitchens);
router.get('/kitchens/:id/details', getKitchenDetails);
router.post('/kitchens/:id/warn', warnKitchen);
router.put('/kitchens/:id/suspend', suspendKitchen);
router.put('/kitchens/:id/unblock', unsuspendKitchen);
router.put('/kitchens/:id/approve', approveKitchen);
router.put('/kitchens/:id/reject', rejectKitchen);
router.delete('/kitchens/:id', superAdminOnly, deleteKitchen);

// Rider Management
router.get('/riders', getRiders);
router.get('/riders/:id', getRiderById);
router.post('/riders/:id/warn', warnRider);
router.put('/riders/:id/suspend', suspendRider);
router.put('/riders/:id/unblock', unsuspendRider);

// Order Management
router.get('/orders', getOrders);
router.put('/orders/:id/force-cancel', forceCancelOrder);
router.post('/orders/:id/refund', refundOrder);

// Notification Management
router.post('/notifications', sendNotification);
router.get('/notifications', getAllNotifications);
router.delete('/notifications/:id', deleteNotification);


// ── Dev/Test Only — NOT available in production ───────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  router.post('/test/broadcast-rider', async (req, res) => {
  try {
    const Rider = require('../models/Rider');
    const io = req.app.get('io');
    if (!io) return res.status(500).json({ success: false, message: 'Socket.io not initialised' });

    // Find target rider — use riderId from body or pick first online rider
    let rider;
    if (req.body.riderId) {
      rider = await Rider.findById(req.body.riderId);
    } else {
      rider = await Rider.findOne({ isOnline: true, accountStatus: 'active' });
    }
    if (!rider) return res.status(404).json({ success: false, message: 'No online rider found' });

    const dummyOrder = {
      _id: 'test_' + Date.now(),
      orderId: 'TEST-' + Math.floor(Math.random() * 9000 + 1000),
      status: 'accepted',
      riderStatus: 'pending',
      deliveryMethod: 'rider',
      deliveryFee: req.body.deliveryFee || 45,
      grandTotal: 350,
      paymentType: 'online',
      paymentStatus: 'paid',
      customerName: 'Test Customer',
      customerPhone: '9876543210',
      deliveryAddress: { address: '12, Test Colony, Near Test Chowk' },
      items: [
        { name: 'Paneer Butter Masala', quantity: 2, price: 150 },
        { name: 'Butter Naan', quantity: 3, price: 20 },
      ],
      customerId: { name: 'Test Customer', phone: '9876543210', avatar: '' },
      kitchenId: {
        _id: 'kitchen_test',
        name: 'Test Kitchen (Dummy)',
        address: 'Shop 5, Test Market, Test City',
        location: { type: 'Point', coordinates: [77.2090, 28.6139] },
        phone: '9000000000',
      },
      pickupOtp: '1234',
      dropOtp: '5678',
      createdAt: new Date().toISOString(),
      __isTestOrder: true,
    };

    const room = `rider_${rider.userId.toString()}`;
    io.to(room).emit('rider:orderBroadcast', dummyOrder);

    if (rider.expoPushToken) {
      const { sendPushNotification } = require('../config/firebase');
      await sendPushNotification(
        rider.expoPushToken, 
        '🛵 New Order!', 
        `${dummyOrder.customerName} • ₹${dummyOrder.deliveryFee} delivery fee | Tap to accept`,
        {
          type: 'order_broadcast',
          orderId: dummyOrder._id.toString(),
          customerName: dummyOrder.customerName,
          kitchenName: dummyOrder.kitchenId.name,
          deliveryFee: String(dummyOrder.deliveryFee)
        }
      );
      console.log(`[TEST BROADCAST] Sent FCM push to token: ${rider.expoPushToken}`);
    }


    console.log(`[TEST BROADCAST] Sent dummy order to room: ${room} (rider: ${rider.name})`);
    return res.json({
      success: true,
      message: `Dummy order sent to rider: ${rider.name}`,
      room,
      orderId: dummyOrder.orderId,
    });
  } catch (err) {
    console.error('[TEST BROADCAST ERROR]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
  });
} // end: dev-only test routes

module.exports = router;
