/**
 * Distance-based delivery pricing (km zones).
 * Shared by place-order, nearby kitchens, and wallet/rider earnings.
 *
 * Zone 1: 0 – 3.0 km  → ₹20 delivery
 * Zone 2: 3.1 – 5.0 km → ₹30 delivery
 * Zone 3: 5.1 – 7.0 km → ₹40 delivery
 * Platform fee: fixed ₹9 (goes to the deliverer — rider or self-delivering seller)
 */

const DEFAULT_PLATFORM_FEE = 9;
const MAX_DELIVERY_DISTANCE_KM = 7;

/** Upper bound (km) → delivery fee. Inclusive ceilings. */
const DELIVERY_ZONES = [
  { maxKm: 3.0, fee: 20 },
  { maxKm: 5.0, fee: 30 },
  { maxKm: 7.0, fee: 40 },
];

function getPlatformFee() {
  const n = parseInt(process.env.PLATFORM_FEE, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLATFORM_FEE;
}

function getMaxDeliveryDistanceKm() {
  const n = parseFloat(process.env.MAX_DELIVERY_DISTANCE_KM);
  return Number.isFinite(n) && n > 0 ? n : MAX_DELIVERY_DISTANCE_KM;
}

/**
 * @param {number} distanceKm
 * @returns {number|null} delivery fee, or null if outside service radius
 */
function getDeliveryFeeForDistance(distanceKm) {
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d < 0) return null;

  const maxKm = getMaxDeliveryDistanceKm();
  if (d > maxKm) return null;

  for (const zone of DELIVERY_ZONES) {
    if (d <= zone.maxKm) return zone.fee;
  }
  return null;
}

/**
 * Full fee breakdown for a distance.
 * @param {number} distanceKm
 * @returns {{ ok: true, distanceKm: number, deliveryFee: number, platformFee: number, customerDeliveryTotal: number }
 *   | { ok: false, message: string }}
 */
function getDeliveryPricing(distanceKm) {
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d < 0) {
    return { ok: false, message: 'Invalid distance for delivery fee.' };
  }

  const roundedKm = Number(d.toFixed(1));
  const deliveryFee = getDeliveryFeeForDistance(roundedKm);
  if (deliveryFee == null) {
    return {
      ok: false,
      message: `Delivery is available within ${getMaxDeliveryDistanceKm()} km only.`,
    };
  }

  const platformFee = getPlatformFee();
  return {
    ok: true,
    distanceKm: roundedKm,
    deliveryFee,
    platformFee,
    customerDeliveryTotal: deliveryFee + platformFee,
  };
}

/** Rider (or self-delivery) earning from fees on an order. */
function getDelivererFeeEarning(order) {
  if (!order) return 0;
  const deliveryFee = Number(order.deliveryFee) || 0;
  
  if (order.deliveryMethod === 'self') {
    return deliveryFee;
  }
  
  const platformFee = Number(order.platformFee) || 0;
  return deliveryFee + platformFee;
}

module.exports = {
  DELIVERY_ZONES,
  DEFAULT_PLATFORM_FEE,
  MAX_DELIVERY_DISTANCE_KM,
  getPlatformFee,
  getMaxDeliveryDistanceKm,
  getDeliveryFeeForDistance,
  getDeliveryPricing,
  getDelivererFeeEarning,
};
