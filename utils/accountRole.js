/** Saved delivery address with coordinates (MongoDB GeoJSON). */
function userHasSavedAddress(user) {
  return (
    Array.isArray(user?.addresses) &&
    user.addresses.some((a) => a?.location?.coordinates?.length === 2)
  );
}

/** Customer who completed onboarding or saved profile data. */
function isEstablishedCustomer(user) {
  if (!user || user.role !== 'customer') return false;
  const hasName = !!(user.name && String(user.name).trim());
  return hasName || userHasSavedAddress(user);
}

/** Kitchen seller with a registered kitchen. */
function isEstablishedKitchenUser(user, kitchenId) {
  return user?.role === 'kitchen' && Boolean(kitchenId);
}

async function customerHasOrders(userId) {
  if (!userId) return false;
  const Order = require('../models/Order');
  const count = await Order.countDocuments({ customerId: userId });
  return count > 0;
}

/** Whether this account may register a new kitchen on the same phone. */
async function canRegisterKitchen(user) {
  if (!user) return false;
  if (user.role === 'kitchen') return true;
  if (user.role !== 'customer') return false;
  if (isEstablishedCustomer(user)) return false;
  if (await customerHasOrders(user._id)) return false;
  return true;
}

/** Whether this account may use the customer ordering flow. */
function canUseCustomerFlow(user, kitchenId) {
  if (!user) return true;
  if (user.role === 'customer') return true;
  return !isEstablishedKitchenUser(user, kitchenId);
}

module.exports = {
  userHasSavedAddress,
  isEstablishedCustomer,
  isEstablishedKitchenUser,
  canRegisterKitchen,
  canUseCustomerFlow,
};
