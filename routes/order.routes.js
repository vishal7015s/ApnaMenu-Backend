const express = require('express');
const router = express.Router();
const {
  placeOrder,
  verifyPayment,
  createPaymentOrder,
  acceptOrder,
  rejectOrder,
  updateStatus,
  switchDeliveryToSelf,
  retryRiderSearch,
  verifyDeliveryOtp,
  getCustomerHistory,
  getCustomerOrderStats,
  getKitchenHistory,
  getKitchenQueue,
  cancelOrder,
  rateOrder,
  createDoorstepQr,
  razorpayWebhook,
  getOrderById,
  dispatchOrder,
  confirmRiderHandover,
} = require('../controllers/order.controller');
const { protect, authorize } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validateObjectId');

// Public Webhook Route (No Auth token required, verified via Razorpay signature)
router.post('/webhook', razorpayWebhook);

router.use(protect);

// Customer routes
router.post('/place', authorize('customer'), placeOrder);
router.post('/verify', authorize('customer'), verifyPayment);
router.post('/create-payment', authorize('customer'), createPaymentOrder);
router.get('/customer/history', authorize('customer'), getCustomerHistory);
router.get('/customer/stats', authorize('customer'), getCustomerOrderStats);

// Kitchen routes (must be before /:id)
router.get('/kitchen/queue', authorize('kitchen'), getKitchenQueue);
router.get('/kitchen/history', authorize('kitchen'), getKitchenHistory);

router.get('/:id', validateObjectId(), getOrderById);
router.post('/:id/cancel', validateObjectId(), cancelOrder);
router.post('/:id/rate', validateObjectId(), authorize('customer'), rateOrder);
router.post('/:id/doorstep-qr', validateObjectId(), protect, createDoorstepQr);

// Kitchen routes
router.put('/:id/accept', validateObjectId(), authorize('kitchen'), acceptOrder);
router.put('/:id/reject', validateObjectId(), authorize('kitchen'), rejectOrder);
router.put('/:id/status', validateObjectId(), authorize('kitchen'), updateStatus);
router.put('/:id/verify-delivery-otp', validateObjectId(), authorize('kitchen'), verifyDeliveryOtp);
router.put('/:id/switch-self', validateObjectId(), authorize('kitchen'), switchDeliveryToSelf);
router.put('/:id/retry-rider', validateObjectId(), authorize('kitchen'), retryRiderSearch);
router.put('/:id/dispatch', validateObjectId(), authorize('kitchen'), dispatchOrder);
router.put('/:id/confirm-handover', validateObjectId(), authorize('kitchen'), confirmRiderHandover);

module.exports = router;

