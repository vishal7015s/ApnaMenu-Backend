// ====================================
// Rider Routes — Partner Operations
// ====================================

const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
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
  logout,
} = require('../controllers/rider.controller');

// All rider operations require authenticated rider role
router.use(protect);
router.use(authorize('rider'));

router.post('/logout', logout);

router.put('/toggle-duty', toggleDuty);
router.put('/location', updateLocation);
router.get('/orders/history', getOrdersHistory);
router.get('/orders/pending-broadcasts', getPendingBroadcasts);
router.get('/orders/:id', getOrderById);
router.post('/orders/:id/accept', acceptBroadcast);
router.post('/orders/:id/reject', rejectBroadcast);
router.put('/orders/:id/pickup', verifyPickup);
router.put('/orders/:id/drop', verifyDrop);
router.get('/profile', getProfile);
router.put('/profile', updateProfile);
router.get('/stats', getRiderStats);
router.get('/earnings-summary', getEarningsSummary);


module.exports = router;
