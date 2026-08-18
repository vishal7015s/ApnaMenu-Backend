const express = require('express');
const rateLimit = require('express-rate-limit');
const { getHomeFeed } = require('../controllers/home.controller');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

const feedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again shortly.' },
});

router.get('/feed', feedLimiter, protect, authorize('customer'), getHomeFeed);

module.exports = router;
