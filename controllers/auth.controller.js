// ====================================
// Auth Controller
// ====================================
const User = require('../models/User');
const admin = require('../config/firebase-admin'); // Import Firebase Admin
const {
  canRegisterKitchen,
  canUseCustomerFlow,
} = require('../utils/accountRole');
const {
  hasCompletedCustomerProfile,
  resolveOnboardingStep,
} = require('../utils/onboarding');
const { generateToken, getTokenVersion } = require('../utils/authTokens');
const { clearAuthCache } = require('../middleware/auth');

/**
 * @desc    Verify Firebase phone auth token and login/register
 * @route   POST /api/auth/verify-otp
 * @access  Public
 */
const verifyOtp = async (req, res) => {
  try {
    const { idToken, role } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: 'Firebase ID Token is required' });
    }

    // Verify Firebase ID Token
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (firebaseErr) {
      console.error('Firebase token verification error:', firebaseErr);
      return res.status(401).json({ success: false, message: 'Invalid or expired Firebase token' });
    }

    // Firebase returns phone number with country code, e.g., "+919999999999"
    // We strip the "+91" if our DB expects 10 digits
    let phone = decodedToken.phone_number;
    if (phone && phone.startsWith('+91')) {
      phone = phone.replace('+91', '');
    } else if (phone && phone.startsWith('+')) {
      phone = phone.substring(3); // General fallback
    }

    if (!phone || phone.length < 10) {
      return res.status(400).json({ success: false, message: 'Invalid phone number from Firebase' });
    }

    // OTP is valid (Firebase verified it) -> Find or Create User
    let isNewUser = false;
    let user = await User.findOne({ phone });
    
    const requestedRole = role || 'customer';

    if (!user) {
      isNewUser = true;
      // New User
      user = await User.create({
        phone,
        role: requestedRole,
        activeRole: requestedRole,
      });
    } else {
      // User exists. Auto-migrate existing riders affected by the old schema bug
      const Rider = require('../models/Rider');
      const existingRider = await Rider.findOne({ userId: user._id });
      if (existingRider && user.role !== 'rider') {
        user.role = 'rider';
        user.activeRole = 'rider';
        await user.save();
      }

      // Enforce 1 number = 1 role rule
      if (requestedRole === 'rider' && user.role !== 'rider') {
        return res.status(403).json({ 
          success: false, 
          message: 'This number is already registered for a Customer or Kitchen account. Please use a new, unique mobile number for your Rider account.' 
        });
      }
      if (requestedRole !== 'rider' && user.role === 'rider') {
        return res.status(403).json({ 
          success: false, 
          message: 'This number is registered as a Rider. Please use the Rider app, or use a different number to order food.' 
        });
      }
    }


    // Check account status
    if (user.accountStatus === 'suspended') {
      return res.status(403).json({ success: false, message: 'Account is suspended' });
    }
    if (user.accountStatus === 'deleted') {
      return res.status(403).json({ success: false, message: 'Account is deleted' });
    }

    // Migrate legacy dual-role accounts to kitchen-only
    if (user.role === 'both') {
      user.role = 'kitchen';
      user.activeRole = 'kitchen';
      await user.save();
    }

    // Attach kitchen details if applicable
    let kitchenId = null;
    let kitchenName = null;
    let kitchenOwnerName = null;
    let kitchenPhoto = null;
    if (user.role === 'kitchen') {
      const Kitchen = require('../models/Kitchen');
      const kitchen = await Kitchen.findOne({ ownerId: user._id });
      if (kitchen) {
        kitchenId = kitchen._id;
        kitchenName = kitchen.name;
        kitchenOwnerName = kitchen.ownerName;
        kitchenPhoto = kitchen.photo;
      }
    }

    let riderProfile = null;
    // If logging in from the rider app, check if they have a Rider profile setup
    if (role === 'rider') {
      const Rider = require('../models/Rider');
      riderProfile = await Rider.findOne({ userId: user._id });

      // Single active rider session: revoke all older JWTs / sockets on this account
      user.tokenVersion = getTokenVersion(user) + 1;
      await user.save();
      clearAuthCache(user._id);

      // Drop stale push token until the new device re-registers
      if (riderProfile?.expoPushToken) {
        riderProfile.expoPushToken = null;
        await riderProfile.save();
      }
    }

    // Generate JWT (includes tokenVersion for session binding)
    const token = generateToken(user._id, getTokenVersion(user));

    // Only use avatar if it's a real user-uploaded photo (not auto-generated)
    let cleanAvatar = kitchenPhoto || user.avatar || '';
    if (cleanAvatar && (cleanAvatar.includes('ui-avatars') || cleanAvatar.includes('flaticon') || cleanAvatar.startsWith('file://'))) {
      cleanAvatar = '';
    }
    // Also filter out old Cloudinary-uploaded default avatars (from apnamenu/avatars folder with auto-generated names)
    if (cleanAvatar && cleanAvatar.includes('cloudinary') && cleanAvatar.includes('apnamenu/avatars') && !kitchenPhoto) {
      cleanAvatar = '';
    }
    const finalAvatar = cleanAvatar;

    const hasName = hasCompletedCustomerProfile(user);
    const onboardingStep = resolveOnboardingStep(user, kitchenId);
    const needsProfileSetup = onboardingStep === 'customer_profile';
    const needsKitchenSetup = onboardingStep === 'kitchen_registration';
    const mayRegisterKitchen = await canRegisterKitchen(user);
    const mayUseCustomerFlow = canUseCustomerFlow(user, kitchenId);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      isNewUser,
      onboardingStep,
      needsProfileSetup,
      needsKitchenSetup,
      profileComplete: onboardingStep === 'complete',
      canRegisterKitchen: mayRegisterKitchen,
      canUseCustomerFlow: mayUseCustomerFlow,
      user: {
        _id: user._id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        activeRole: user.activeRole,
        signupIntent: user.signupIntent || null,
        language: user.language,
        addresses: user.addresses,
        kitchenId,
        kitchenName,
        kitchenOwnerName,
        kitchenPhoto,
        avatar: finalAvatar,
        profileImage: finalAvatar,
        accountStatus: user.accountStatus,
      },
      riderProfile,
    });
  } catch (error) {
    console.error('Verify OTP Error:', error);
    res.status(500).json({ success: false, message: 'Server error verifying OTP' });
  }
};

/**
 * @desc    Google OAuth login
 * @route   POST /api/auth/google
 * @access  Public
 */
const googleAuth = async (req, res) => {
  res.status(200).json({ success: true, message: 'Google auth (stub)' });
};

/**
 * @desc    Refresh JWT token
 * @route   POST /api/auth/refresh-token
 * @access  Private
 */
const refreshToken = async (req, res) => {
  try {
    if (!req.user || req.user.accountStatus === 'suspended' || req.user.accountStatus === 'deleted') {
      return res.status(403).json({ success: false, message: 'Account is not active' });
    }
    // Same session — do NOT bump tokenVersion
    const token = generateToken(req.user._id, getTokenVersion(req.user));
    return res.status(200).json({
      success: true,
      message: 'Token refreshed',
      token,
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    return res.status(500).json({ success: false, message: 'Server error refreshing token' });
  }
};

module.exports = { verifyOtp, googleAuth, refreshToken };
