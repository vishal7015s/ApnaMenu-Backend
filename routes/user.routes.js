const express = require('express');
const router = express.Router();
const {
  getProfile,
  updateProfile,
  addAddress,
  updateAddress,
  deleteAddress,
  updateLanguage,
  submitDeleteRequest,
} = require('../controllers/user.controller');
const { protect } = require('../middleware/auth');

// All user routes are protected
router.use(protect);

router.get('/profile', getProfile);
router.put('/profile', updateProfile);

router.post('/address', addAddress);
router.put('/address/:id', updateAddress);
router.delete('/address/:id', deleteAddress);

router.put('/language', updateLanguage);

router.post('/delete-request', submitDeleteRequest);

module.exports = router;
