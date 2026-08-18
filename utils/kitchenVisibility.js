const VERIFICATION = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

/**
 * Mongo filter for kitchens visible on the customer app (discovery, search, orders).
 * Existing kitchens without verificationStatus remain visible for backward compatibility.
 */
function customerVisibleKitchenFilter(extra = {}) {
  return {
    ...extra,
    accountStatus: 'active',
    $or: [
      { verificationStatus: VERIFICATION.APPROVED },
      { verificationStatus: { $exists: false } },
    ],
  };
}

function isKitchenCustomerVisible(kitchen) {
  if (!kitchen) return false;
  if (kitchen.accountStatus && kitchen.accountStatus !== 'active') return false;
  const status = kitchen.verificationStatus;
  if (!status || status === VERIFICATION.APPROVED) return true;
  return false;
}

function isKitchenVerifiedForSeller(kitchen) {
  if (!kitchen) return false;
  const status = kitchen.verificationStatus;
  return !status || status === VERIFICATION.APPROVED;
}

/** Admin/users list — approved + legacy kitchens without verificationStatus */
function verifiedSellerKitchenFilter(extra = {}) {
  return {
    ...extra,
    $or: [
      { verificationStatus: VERIFICATION.APPROVED },
      { verificationStatus: { $exists: false } },
    ],
  };
}

/** Admin pending-verification queue (exclude soft-deleted accounts). */
function pendingAdminKitchenFilter(extra = {}) {
  return {
    ...extra,
    verificationStatus: VERIFICATION.PENDING,
    accountStatus: { $ne: 'deleted' },
  };
}

module.exports = {
  VERIFICATION,
  customerVisibleKitchenFilter,
  isKitchenCustomerVisible,
  isKitchenVerifiedForSeller,
  verifiedSellerKitchenFilter,
  pendingAdminKitchenFilter,
};
