/**
 * Shared order acceptance/rejection constants and guards.
 */
const ALREADY_ACCEPTED_STATUSES = [
  'PENDING_CUSTOMER_PAYMENT', 'accepted', 'preparing', 'ready', 'outForDelivery', 'delivered',
];
const PENDING_ACCEPT_STATUSES = ['placed', 'PENDING_SELLER_APPROVAL'];
const REJECTABLE_STATUSES = ['placed', 'PENDING_SELLER_APPROVAL', 'PENDING_CUSTOMER_PAYMENT'];

function isAlreadyAccepted(status) {
  return ALREADY_ACCEPTED_STATUSES.includes(status);
}

function isPendingAccept(status) {
  return PENDING_ACCEPT_STATUSES.includes(status);
}

function isRejectable(status) {
  return REJECTABLE_STATUSES.includes(status);
}

module.exports = {
  ALREADY_ACCEPTED_STATUSES,
  PENDING_ACCEPT_STATUSES,
  REJECTABLE_STATUSES,
  isAlreadyAccepted,
  isPendingAccept,
  isRejectable,
};
