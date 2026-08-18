const mongoose = require('mongoose');

const MIN_MENU_PRICE = 1;
const MAX_MENU_PRICE = 50000;
const MIN_WITHDRAWAL = 100;

/** Kitchen registration / profile name limits (keep in sync with mobile) */
const KITCHEN_NAME_MIN = 3;
const KITCHEN_NAME_MAX = 40;
const OWNER_NAME_MIN = 2;
const OWNER_NAME_MAX = 30;

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/i;
const UPI_REGEX = /^[\w.\-]{2,256}@[\w.\-]{2,64}$/i;

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

function validateMenuPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n < MIN_MENU_PRICE || n > MAX_MENU_PRICE) {
    return { ok: false, message: `Price must be between ₹${MIN_MENU_PRICE} and ₹${MAX_MENU_PRICE}` };
  }
  return { ok: true, value: n };
}

function validateOriginalPrice(price, originalPrice) {
  if (originalPrice == null || originalPrice === '') {
    return { ok: true, value: null };
  }
  const orig = Number(originalPrice);
  const sell = Number(price);
  if (!Number.isFinite(orig) || orig <= 0) {
    return { ok: true, value: null };
  }
  if (orig > MAX_MENU_PRICE) {
    return { ok: false, message: `Original price cannot exceed ₹${MAX_MENU_PRICE}` };
  }
  if (!Number.isFinite(sell) || orig <= sell) {
    return { ok: false, message: 'Original price must be greater than selling price.' };
  }
  return { ok: true, value: orig };
}

function validateIfsc(ifsc) {
  if (!ifsc || !IFSC_REGEX.test(String(ifsc).trim())) {
    return { ok: false, message: 'Invalid IFSC code format' };
  }
  return { ok: true, value: String(ifsc).trim().toUpperCase() };
}

function validateUpi(upi) {
  const trimmed = String(upi || '').trim();
  if (!trimmed || !UPI_REGEX.test(trimmed)) {
    return { ok: false, message: 'Invalid UPI ID format' };
  }
  return { ok: true, value: trimmed };
}

function validateBankAccount(accountNumber) {
  const trimmed = String(accountNumber || '').replace(/\s/g, '');
  if (!/^\d{9,18}$/.test(trimmed)) {
    return { ok: false, message: 'Bank account number must be 9–18 digits' };
  }
  return { ok: true, value: trimmed };
}

function isDevOtpAllowed(otp) {
  return process.env.ALLOW_DEV_OTP === 'true' && otp === '1234';
}

function isMockPaymentAllowed() {
  return process.env.ALLOW_MOCK_PAYMENTS === 'true';
}

/** Accept legacy flat strings or structured User.addresses payload from the mobile app. */
function validateDeliveryAddress(deliveryAddress) {
  if (!deliveryAddress || typeof deliveryAddress !== 'object') {
    return { ok: false, message: 'Delivery address is required.' };
  }

  const flat = String(deliveryAddress.address || deliveryAddress.fullAddress || '').trim();
  if (flat) return { ok: true };

  const house = String(deliveryAddress.house || '').trim();
  const landmark = String(deliveryAddress.landmark || '').trim();
  if (house || landmark) return { ok: true };

  return { ok: false, message: 'Delivery address is required.' };
}

const MENU_NAME_MIN = 2;
const MENU_NAME_MAX = 80;
const MENU_DESC_MAX = 500;
const MENU_TAG_MAX = 30;
const MENU_TAGS_MAX_COUNT = 10;

function normalizeMenuTags(tags) {
  let list = [];
  if (Array.isArray(tags)) {
    list = tags.map((t) => String(t || '').trim()).filter(Boolean);
  } else if (typeof tags === 'string' && tags.trim()) {
    list = tags.split(',').map((t) => t.trim()).filter(Boolean);
  }

  if (list.length > MENU_TAGS_MAX_COUNT) {
    return { ok: false, message: `You can add at most ${MENU_TAGS_MAX_COUNT} tags.` };
  }

  for (const tag of list) {
    if (tag.length > MENU_TAG_MAX) {
      return { ok: false, message: `Each tag cannot exceed ${MENU_TAG_MAX} characters.` };
    }
  }

  return { ok: true, value: list };
}

function validateKitchenName(name, { required = true } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    if (!required) return { ok: true, value: trimmed };
    return { ok: false, message: 'Restaurant name is required.' };
  }
  if (trimmed.length < KITCHEN_NAME_MIN) {
    return {
      ok: false,
      message: `Restaurant name must be at least ${KITCHEN_NAME_MIN} characters.`,
    };
  }
  if (trimmed.length > KITCHEN_NAME_MAX) {
    return {
      ok: false,
      message: `Restaurant name cannot exceed ${KITCHEN_NAME_MAX} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

function validateOwnerName(name, { required = true } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    if (!required) return { ok: true, value: trimmed };
    return { ok: false, message: 'Owner name is required.' };
  }
  if (trimmed.length < OWNER_NAME_MIN) {
    return {
      ok: false,
      message: `Owner name must be at least ${OWNER_NAME_MIN} characters.`,
    };
  }
  if (trimmed.length > OWNER_NAME_MAX) {
    return {
      ok: false,
      message: `Owner name cannot exceed ${OWNER_NAME_MAX} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate menu item text fields for add/update.
 * Pass only fields present in the request; omit name on update if unchanged.
 */
function validateMenuItemTextFields({ name, description, tags } = {}, { nameRequired = false } = {}) {
  const out = {};

  if (nameRequired || name !== undefined) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
      return { ok: false, message: 'Item name is required.' };
    }
    if (trimmedName.length < MENU_NAME_MIN) {
      return { ok: false, message: `Item name must be at least ${MENU_NAME_MIN} characters.` };
    }
    if (trimmedName.length > MENU_NAME_MAX) {
      return { ok: false, message: `Item name cannot exceed ${MENU_NAME_MAX} characters.` };
    }
    out.name = trimmedName;
  }

  if (description !== undefined) {
    const trimmedDesc = String(description || '').trim();
    if (trimmedDesc.length > MENU_DESC_MAX) {
      return { ok: false, message: `Description cannot exceed ${MENU_DESC_MAX} characters.` };
    }
    out.description = trimmedDesc;
  }

  if (tags !== undefined) {
    const tagCheck = normalizeMenuTags(tags);
    if (!tagCheck.ok) return tagCheck;
    out.tags = tagCheck.value;
  }

  return { ok: true, value: out };
}

module.exports = {
  MIN_MENU_PRICE,
  MAX_MENU_PRICE,
  MIN_WITHDRAWAL,
  MENU_NAME_MIN,
  MENU_NAME_MAX,
  MENU_DESC_MAX,
  MENU_TAG_MAX,
  MENU_TAGS_MAX_COUNT,
  KITCHEN_NAME_MIN,
  KITCHEN_NAME_MAX,
  OWNER_NAME_MIN,
  OWNER_NAME_MAX,
  isValidObjectId,
  validateMenuPrice,
  validateOriginalPrice,
  validateIfsc,
  validateUpi,
  validateBankAccount,
  isDevOtpAllowed,
  isMockPaymentAllowed,
  validateDeliveryAddress,
  validateKitchenName,
  validateOwnerName,
  validateMenuItemTextFields,
  normalizeMenuTags,
};
