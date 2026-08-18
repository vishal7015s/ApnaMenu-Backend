const CUSTOMER_ORDER_LIST_SELECT =
  'orderId status items itemTotal grandTotal deliveryFee platformFee distance paymentType paymentStatus deliveryMethod kitchenId placedAt createdAt cancelReason isRated rating schedule onlineAmount cashAmount customerName';

const CUSTOMER_ORDER_DETAIL_SELECT =
  `${CUSTOMER_ORDER_LIST_SELECT} deliveryAddress deliveryLocation riderId riderStatus acceptedAt prepStartedAt outForDeliveryAt deliveredAt cancelledAt razorpayOrderId paymentType doorPaymentMode dropOtp deliveryOtp kitchenHandoverAt`;

const CUSTOMER_STRIP_FIELDS = [
  'pickupOtp',
  // dropOtp/deliveryOtp intentionally NOT stripped — customer needs this to verify delivery
  'razorpaySignature',
  'razorpayPaymentId',
  'riderBroadcasts',
  'riderRejections',
  'walletSettled',
  'razorpayKeyId',
];

function toPlain(order) {
  if (!order) return null;
  return typeof order.toObject === 'function' ? order.toObject() : { ...order };
}

function toCustomerOrderDTO(order) {
  const plain = toPlain(order);
  if (!plain) return null;
  CUSTOMER_STRIP_FIELDS.forEach((key) => {
    delete plain[key];
  });
  return plain;
}

function toCustomerOrderListDTO(orders) {
  return (orders || []).map((o) => toCustomerOrderDTO(o));
}

module.exports = {
  CUSTOMER_ORDER_LIST_SELECT,
  CUSTOMER_ORDER_DETAIL_SELECT,
  toCustomerOrderDTO,
  toCustomerOrderListDTO,
};
