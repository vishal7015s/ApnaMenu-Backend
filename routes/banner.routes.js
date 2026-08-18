const express = require('express');
const router = express.Router();
const { 
  getBanners, 
  getAllBannersAdmin, 
  createBanner, 
  deleteBanner 
} = require('../controllers/banner.controller');

// For simplicity, we are not adding 'protect' middleware to admin routes yet,
// but in a production environment, you should wrap POST/DELETE with protectAdmin.

router.get('/', getBanners);
router.get('/admin', getAllBannersAdmin);
router.post('/', createBanner);
router.delete('/:id', deleteBanner);

module.exports = router;
