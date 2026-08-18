const express = require('express');
const router = express.Router();
const {
  addItem,
  updateItem,
  toggleStock,
  deleteItem,
  getKitchenMenu,
  getMyKitchenMenu,
  getMyMenuItem,
  searchMenu,
  getDishDetail,
  getDishReviews,
  markReviewHelpful,
  getMenuCategories,
} = require('../controllers/menu.controller');
const { protect, authorize } = require('../middleware/auth');

// Public routes for browsing menus and dishes
router.get('/categories', getMenuCategories);
router.get('/kitchen/:kitchenId/items', getKitchenMenu);
router.get('/search', searchMenu);
router.get('/dish/:dishId', getDishDetail);
router.get('/dish/:dishId/reviews', getDishReviews);
router.post('/dish/:dishId/reviews/:reviewId/helpful', protect, authorize('customer'), markReviewHelpful);

// Kitchen only routes
router.use(protect, authorize('kitchen'));

router.get('/kitchen', getMyKitchenMenu);
router.get('/item/:id', getMyMenuItem);
router.post('/item', addItem);
router.put('/item/:id', updateItem);
router.put('/item/:id/toggle-stock', toggleStock);
router.delete('/item/:id', deleteItem);

module.exports = router;
