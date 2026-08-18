// ====================================
// Cloudinary Configuration
// ====================================

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload image to Cloudinary
 * @param {string} filePath - Local file path or base64 string
 * @param {string} folder - Cloudinary folder name
 * @param {object} options - Extra Cloudinary options
 * @returns {Promise<{url: string, publicId: string}>}
 */
const uploadImage = async (filePath, folder = 'apnamenu', options = {}) => {
  try {
    const transformation = options.transformation || [
      { width: 800, height: 600, crop: 'limit' },
      { quality: 'auto', fetch_format: 'auto' },
    ];
    const result = await cloudinary.uploader.upload(filePath, {
      folder,
      transformation,
      ...options.uploadOptions,
    });
    return {
      url: result.secure_url,
      publicId: result.public_id,
    };
  } catch (error) {
    console.error('❌ Cloudinary Upload Error:', error.message);
    throw new Error('Image upload failed');
  }
};

/** KYC docs — private so URLs are not world-readable without a signed link */
const uploadPrivateDocument = async (filePath, folder = 'apnamenu/documents') => {
  return uploadImage(filePath, folder, {
    uploadOptions: {
      type: 'private',
      access_mode: 'authenticated',
    },
    transformation: [
      { width: 1600, height: 1600, crop: 'limit' },
      { quality: 'auto', fetch_format: 'auto' },
    ],
  });
};

/** Short-lived signed URL for private KYC documents (client preview) */
const getSignedDocumentUrl = (publicId, expiresInSec = 3600) => {
  if (!publicId) return '';
  try {
    return cloudinary.url(publicId, {
      type: 'private',
      sign_url: true,
      secure: true,
      expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
    });
  } catch (e) {
    console.error('❌ Cloudinary sign URL error:', e.message);
    return '';
  }
};

/**
 * Delete image from Cloudinary
 * @param {string} publicId - Cloudinary public ID
 */
const deleteImage = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('❌ Cloudinary Delete Error:', error.message);
  }
};

module.exports = { cloudinary, uploadImage, uploadPrivateDocument, getSignedDocumentUrl, deleteImage };
