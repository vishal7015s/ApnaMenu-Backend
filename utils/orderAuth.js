function getUserId(user) {
  if (!user) return null;
  const id = user.id ?? user._id;
  return id != null ? String(id) : null;
}

function getRefId(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  const id = ref._id ?? ref.id ?? ref;
  return id != null ? String(id) : null;
}

function isOrderCustomer(order, user) {
  const userId = getUserId(user);
  const customerId = getRefId(order?.customerId);
  return Boolean(userId && customerId && userId === customerId);
}

function isOrderKitchen(order, user) {
  const kitchenId = getRefId(order?.kitchenId);
  const userKitchenId = getRefId(user?.kitchenId);
  return Boolean(kitchenId && userKitchenId && kitchenId === userKitchenId);
}

function isOrderRider(order, user) {
  const riderId = getRefId(order?.riderId);
  const userId = getUserId(user);
  return Boolean(riderId && userId && riderId === userId);
}

module.exports = {
  getUserId,
  getRefId,
  isOrderCustomer,
  isOrderKitchen,
  isOrderRider,
};
