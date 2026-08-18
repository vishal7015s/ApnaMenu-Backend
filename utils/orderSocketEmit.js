/**
 * Emit order events to both order-specific and customer user rooms.
 */
function emitOrderToCustomer(io, order, event, payload) {
  if (!io || !order) return;
  const orderId = order._id || order.orderId;
  if (orderId) {
    io.to(`order_${orderId}`).emit(event, payload);
  }
  const customerId = order.customerId?._id || order.customerId;
  if (customerId) {
    io.to(`user_${customerId}`).emit(event, payload);
  }
}

module.exports = { emitOrderToCustomer };
