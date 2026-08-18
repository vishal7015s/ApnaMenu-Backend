// ====================================
// User Controller — Full Implementation
// ====================================

const User = require('../models/User');

/**
 * GET /api/users/profile
 */
const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-__v').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // If avatar is empty/invalid/auto-generated, set to null so frontend renders default icon
    if (!user.avatar || user.avatar.trim() === '' || user.avatar.includes('flaticon') || user.avatar.startsWith('file://') || user.avatar.includes('ui-avatars')) {
      user.avatar = null;
    }
    // Also clear old Cloudinary-uploaded default avatars
    if (user.avatar && user.avatar.includes('cloudinary') && user.avatar.includes('apnamenu/avatars')) {
      user.avatar = null;
    }
    user.profileImage = user.avatar;

    const Kitchen = require('../models/Kitchen');
    const kitchen = await Kitchen.findOne({ ownerId: user._id }).select('_id name photo ownerName').lean();
    if (kitchen) {
      user.kitchenId = kitchen._id;
      user.kitchenName = kitchen.name;
      user.kitchenPhoto = kitchen.photo;
      user.kitchenOwnerName = kitchen.ownerName;
    }

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('getProfile error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/users/profile
 */
const updateProfile = async (req, res) => {
  try {
    const { name, avatar, profileImage, role, signupIntent } = req.body;
    const updates = {};
    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({
          success: false,
          message: 'Name is required.',
        });
      }
      if (trimmedName.length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Name must be at least 2 characters.',
        });
      }
      if (trimmedName.length > 40) {
        return res.status(400).json({
          success: false,
          message: 'Name cannot exceed 40 characters.',
        });
      }
      updates.name = trimmedName;
      if (trimmedName && req.user.signupIntent === 'customer') {
        updates.signupIntent = null;
      }
    }
    if (signupIntent !== undefined) {
      if (signupIntent === 'customer' || signupIntent === 'kitchen') {
        updates.signupIntent = signupIntent;
      } else if (signupIntent === null || signupIntent === '') {
        updates.signupIntent = null;
      }
    }

    // Role changes are restricted — clients cannot change role without backend registration flow
    if (role !== undefined && role === 'customer' && req.user.role === 'customer') {
      updates.role = role;
    }

    const photo = avatar || profileImage;
    if (photo && photo.startsWith('data:image')) {
      const { uploadImage } = require('../config/cloudinary');
      const uploadRes = await uploadImage(photo, 'apnamenu/users', {
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'auto' },
          { quality: 'auto:good', fetch_format: 'auto' },
        ],
      });
      updates.avatar = uploadRes.url;
    } else if (photo && !photo.startsWith('file://')) {
      updates.avatar = photo;
    } else if (name !== undefined) {
      // If no custom photo uploaded, clear any old ui-avatars/flaticon URLs
      const currentUser = await User.findById(req.user._id);
      if (currentUser.avatar && (currentUser.avatar.includes('ui-avatars') || currentUser.avatar.includes('flaticon') || currentUser.avatar.startsWith('file://'))) {
        updates.avatar = null;
      }
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-__v').lean();
    if (user) {
      user.profileImage = user.avatar;
    }

    res.json({ success: true, message: 'Profile updated.', data: user });
  } catch (error) {
    console.error('updateProfile error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/users/address
 */
const HOUSE_LANDMARK_MIN = 2;
const HOUSE_LANDMARK_MAX = 80;

function validateHouseLandmark(house, landmark) {
  const h = house != null ? String(house).trim() : '';
  const l = landmark != null ? String(landmark).trim() : '';
  if (!h || !l) {
    return { ok: false, message: 'house, landmark, latitude, and longitude are required.' };
  }
  if (h.length < HOUSE_LANDMARK_MIN) {
    return { ok: false, message: 'House / company name must be at least 2 characters.' };
  }
  if (h.length > HOUSE_LANDMARK_MAX) {
    return { ok: false, message: 'House / company name cannot exceed 80 characters.' };
  }
  if (l.length < HOUSE_LANDMARK_MIN) {
    return { ok: false, message: 'Landmark must be at least 2 characters.' };
  }
  if (l.length > HOUSE_LANDMARK_MAX) {
    return { ok: false, message: 'Landmark cannot exceed 80 characters.' };
  }
  return { ok: true, house: h, landmark: l };
}

const addAddress = async (req, res) => {
  try {
    const { label, house, landmark, latitude, longitude, isDefault } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'house, landmark, latitude, and longitude are required.',
      });
    }

    const checked = validateHouseLandmark(house, landmark);
    if (!checked.ok) {
      return res.status(400).json({ success: false, message: checked.message });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.addresses && user.addresses.length >= 3) {
      return res.status(400).json({
        success: false,
        message: 'You can save a maximum of 3 addresses. Please delete an old address to add a new one.',
      });
    }

    const newAddr = {
      label: label || 'home',
      house: checked.house,
      landmark: checked.landmark,
      location: {
        type: 'Point',
        coordinates: [parseFloat(longitude), parseFloat(latitude)],
      },
    };

    user.addresses.push(newAddr);
    user.markModified('addresses');
    await user.save();

    res.status(201).json({
      success: true,
      message: 'Address added.',
      data: user.addresses,
    });
  } catch (error) {
    console.error('addAddress error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/users/address/:id
 */
const updateAddress = async (req, res) => {
  try {
    const { label, house, landmark, latitude, longitude } = req.body;
    const addressId = req.params.id;

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    const address = user.addresses.id(addressId);

    if (!address) {
      return res.status(404).json({ success: false, message: 'Address not found.' });
    }

    if (label) address.label = label;

    if (house !== undefined || landmark !== undefined) {
      const checked = validateHouseLandmark(
        house !== undefined ? house : address.house,
        landmark !== undefined ? landmark : address.landmark,
      );
      if (!checked.ok) {
        return res.status(400).json({ success: false, message: checked.message });
      }
      address.house = checked.house;
      address.landmark = checked.landmark;
    }

    if (latitude && longitude) {
      address.location = {
        type: 'Point',
        coordinates: [parseFloat(longitude), parseFloat(latitude)],
      };
    }

    user.markModified('addresses');
    await user.save();

    res.json({ success: true, message: 'Address updated.', data: user.addresses });
  } catch (error) {
    console.error('updateAddress error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/users/address/:id
 */
const deleteAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    user.addresses = user.addresses.filter(a => a._id.toString() !== req.params.id.toString());

    user.markModified('addresses');
    await user.save();

    res.json({ success: true, message: 'Address deleted.', data: user.addresses });
  } catch (error) {
    console.error('deleteAddress error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/users/language
 */
const updateLanguage = async (req, res) => {
  try {
    const { language } = req.body;
    if (!['en', 'hi'].includes(language)) {
      return res.status(400).json({ success: false, message: 'Language must be en or hi.' });
    }

    await User.findByIdAndUpdate(req.user._id, { language });

    res.json({ success: true, message: `Language set to ${language}.` });
  } catch (error) {
    console.error('updateLanguage error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const updatePushToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) {
      return res.status(400).json({ success: false, message: 'Push token is required' });
    }
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { fcmToken },
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, message: 'Push token updated successfully' });
  } catch (error) {
    console.error('updatePushToken error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const AccountDeletion = require('../models/AccountDeletion');
const { sendTelegramAlert } = require('../services/telegram.service');

const submitDeleteRequest = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Check if a pending request already exists
    const existing = await AccountDeletion.findOne({ user: user._id, status: 'Pending' });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Delete request already pending.' });
    }

    const reason = (req.body && req.body.reason) ? req.body.reason : 'Requested via app';

    const deleteRoleRaw = req.user.activeRole || req.user.role || 'customer';
    const deleteRole = deleteRoleRaw === 'kitchen' ? 'kitchen' : deleteRoleRaw;

    await AccountDeletion.create({
      user: user._id,
      role: deleteRole,
      reason,
    });

    // Send Telegram Alert
    sendTelegramAlert(
      `🚨 *Account Deletion Request*\n\n` +
      `User: ${user.name || 'Unknown'}\n` +
      `Phone: ${user.phone}\n` +
      `Role: ${deleteRole}\n` +
      `Reason: ${reason}`
    );

    res.json({ success: true, message: 'Account deletion request submitted.' });
  } catch (error) {
    console.error('submitDeleteRequest error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getProfile, updateProfile, addAddress, updateAddress,
  deleteAddress, updateLanguage, updatePushToken,
  submitDeleteRequest
};
