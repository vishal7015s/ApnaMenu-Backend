const express = require('express');
const router = express.Router();
const {
  registerKitchen,
  getNearbyKitchens,
  toggleStatus,
  getDashboard,
  getEarnings,
  getDailyStats,
  updateProfile,
  getReviews,
  updatePushToken,
} = require('../controllers/kitchen.controller');
const { getKitchenMenu } = require('../controllers/menu.controller');
const { protect, authorize } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validateObjectId');

// Public/Customer routes
router.get('/nearby', protect, authorize('customer'), getNearbyKitchens);
router.get('/:kitchenId/menu', protect, authorize('customer'), validateObjectId('kitchenId'), getKitchenMenu);

// Allow any authenticated user to register a kitchen
router.post('/register', protect, registerKitchen);

// Kitchen only routes
router.use(protect, authorize('kitchen'));
router.put('/toggle-status', toggleStatus);
router.put('/push-token', updatePushToken);
router.put('/profile', updateProfile);
router.get('/dashboard', getDashboard);
router.get('/stats', getDailyStats);
router.get('/earnings', getEarnings);
router.get('/reviews', getReviews);
router.post('/withdraw', (req, res) => res.status(410).json({
  success: false,
  message: 'This endpoint is deprecated. Use POST /api/wallets/withdraw instead.',
}));

module.exports = router;
