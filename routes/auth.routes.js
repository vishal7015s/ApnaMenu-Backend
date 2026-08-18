const express = require('express');
const router = express.Router();
const {
  verifyOtp,
  googleAuth,
  refreshToken,
} = require('../controllers/auth.controller');
const { otpRateLimiter } = require('../middleware/rateLimiter');
const { protect } = require('../middleware/auth');

// Public routes — OTP is sent by Firebase on the client; backend only verifies idToken
router.post('/verify-otp', otpRateLimiter, verifyOtp);
router.post('/google', googleAuth);

// Protected routes
router.post('/refresh-token', protect, refreshToken);
router.get('/profile', protect, require('../controllers/user.controller').getProfile);
router.put('/profile', protect, require('../controllers/user.controller').updateProfile);
router.put('/push-token', protect, require('../controllers/user.controller').updatePushToken);

module.exports = router;
