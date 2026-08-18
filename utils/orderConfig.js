const {
  getDeliveryFeeForDistance,
  getPlatformFee,
  getDeliveryPricing,
} = require('./deliveryPricing');

/** @deprecated Prefer distance-based getDeliveryPricing — kept for fallbacks only */
function getDefaultDeliveryFee() {
  const n = parseInt(process.env.DEFAULT_DELIVERY_FEE, 10);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

function getPartialCodOnlinePercent() {
  const n = parseInt(process.env.PARTIAL_COD_ONLINE_PERCENT, 10);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : 50;
}

module.exports = {
  getDefaultDeliveryFee,
  getPartialCodOnlinePercent,
  getDeliveryFeeForDistance,
  getPlatformFee,
  getDeliveryPricing,
};
