/**
 * Kitchen-facing order payload — never expose OTP secrets.
 * Kitchen ENTERS OTPs shown by rider/customer; it must not receive them in API/socket.
 */
const KITCHEN_OTP_STRIP_FIELDS = ['pickupOtp', 'dropOtp', 'deliveryOtp'];

function toPlain(order) {
  if (!order) return null;
  return typeof order.toObject === 'function' ? order.toObject() : { ...order };
}

function toKitchenOrderDTO(order) {
  const plain = toPlain(order);
  if (!plain) return null;
  KITCHEN_OTP_STRIP_FIELDS.forEach((key) => {
    delete plain[key];
  });
  return plain;
}

function toKitchenOrderListDTO(orders) {
  return (orders || []).map((o) => toKitchenOrderDTO(o));
}

/** Sanitize socket/API payloads that may nest `order` or be the order itself. */
function sanitizeKitchenOrderPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.order) {
    return { ...payload, order: toKitchenOrderDTO(payload.order) };
  }
  // Direct order document (e.g. order:new)
  if (payload._id != null || payload.orderId != null) {
    return toKitchenOrderDTO(payload);
  }
  return payload;
}

module.exports = {
  KITCHEN_OTP_STRIP_FIELDS,
  toKitchenOrderDTO,
  toKitchenOrderListDTO,
  sanitizeKitchenOrderPayload,
};
