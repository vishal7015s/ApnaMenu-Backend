// ====================================
// Wallet & Digital Ledger Routes
// ====================================

const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { 
  getMyWallet, 
  createDepositOrder, 
  verifyDeposit, 
  requestWithdrawal, 
  getWalletTransactions 
} = require('../controllers/wallet.controller');

router.use(protect);
router.use(authorize('rider', 'kitchen'));

router.get('/me', getMyWallet);
router.post('/deposit/order', createDepositOrder);
router.post('/deposit/verify', verifyDeposit);
router.post('/withdraw', requestWithdrawal);
router.get('/transactions', getWalletTransactions);

module.exports = router;
