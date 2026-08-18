const express = require('express');
const rateLimit = require('express-rate-limit');
const { getTrendingDishes, getCategoryDishes } = require('../controllers/dish.controller');
const { getDishDetail } = require('../controllers/menu.controller');
const { protect, authorize } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validateObjectId');

const router = express.Router();

const browseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again shortly.' },
});

router.get('/trending', browseLimiter, protect, authorize('customer'), getTrendingDishes);
router.get('/category/:categoryName', browseLimiter, protect, authorize('customer'), getCategoryDishes);
router.get('/:dishId', browseLimiter, protect, authorize('customer'), validateObjectId('dishId'), getDishDetail);

module.exports = router;
