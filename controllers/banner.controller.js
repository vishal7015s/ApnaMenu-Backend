const Banner = require('../models/Banner');
const { uploadImage, deleteImage } = require('../config/cloudinary');
const bannerCache = require('../services/bannerCache.service');

/**
 * @route GET /api/banners
 * @desc Get all active banners (sorted by order)
 * @access Public
 */
const getBanners = async (req, res) => {
  try {
    const banners = await bannerCache.getActive();
    res.status(200).json({ success: true, count: banners.length, data: banners });
  } catch (error) {
    console.error('Error fetching banners:', error);
    res.status(500).json({ success: false, message: 'Server Error', error: error.message });
  }
};

/**
 * @route GET /api/banners/admin
 * @desc Get all banners (active and inactive) for admin panel
 * @access Private/Admin
 */
const getAllBannersAdmin = async (req, res) => {
  try {
    const banners = await Banner.find().sort({ order: 1, createdAt: -1 });
    res.status(200).json({ success: true, count: banners.length, data: banners });
  } catch (error) {
    console.error('Error fetching admin banners:', error);
    res.status(500).json({ success: false, message: 'Server Error', error: error.message });
  }
};

/**
 * @route POST /api/banners
 * @desc Create a new banner
 * @access Private/Admin
 */
const createBanner = async (req, res) => {
  try {
    const { title, imageBase64, isActive, order, actionType, actionData } = req.body;
    
    if (!title || !imageBase64) {
      return res.status(400).json({ success: false, message: 'Title and image are required' });
    }

    // Upload image to Cloudinary
    const uploadRes = await uploadImage(imageBase64, 'apnamenu/banners');
    
    const newBanner = new Banner({
      title,
      imageUrl: uploadRes.url,
      isActive: isActive !== undefined ? isActive : true,
      order: order || 0,
      actionType,
      actionData
    });

    await newBanner.save();
    await bannerCache.invalidate();

    res.status(201).json({ success: true, data: newBanner });
  } catch (error) {
    console.error('Error creating banner:', error);
    res.status(500).json({ success: false, message: 'Server Error', error: error.message });
  }
};

/**
 * @route DELETE /api/banners/:id
 * @desc Delete a banner
 * @access Private/Admin
 */
const deleteBanner = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);
    if (!banner) {
      return res.status(404).json({ success: false, message: 'Banner not found' });
    }
    
    // Attempt to delete from cloudinary if possible, though not strictly required
    // (Requires extracting publicId from URL if deleteImage is implemented that way)
    
    await banner.deleteOne();
    await bannerCache.invalidate();
    res.status(200).json({ success: true, message: 'Banner removed' });
  } catch (error) {
    console.error('Error deleting banner:', error);
    res.status(500).json({ success: false, message: 'Server Error', error: error.message });
  }
};

module.exports = {
  getBanners,
  getAllBannersAdmin,
  createBanner,
  deleteBanner
};
