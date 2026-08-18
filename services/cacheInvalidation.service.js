const mongoose = require('mongoose');
const Kitchen = require('../models/Kitchen');
const MenuItem = require('../models/MenuItem');
const menuCache = require('./menuCache.service');
const nearbyCache = require('./nearbyCache.service');
const trendingCache = require('./trendingDishesCache.service');
const categoryCache = require('./categoryDishesCache.service');

/**
 * Resolve kitchen GeoJSON coordinates [lng, lat] from a document or DB lookup.
 */
async function resolveKitchenCoords(kitchenOrId) {
  if (kitchenOrId?.location?.coordinates?.length >= 2) {
    return kitchenOrId.location.coordinates;
  }

  const id = kitchenOrId?._id || kitchenOrId;
  if (!id) return null;

  const kitchen = await Kitchen.findById(id).select('location.coordinates').lean();
  if (!kitchen?.location?.coordinates || kitchen.location.coordinates.length < 2) {
    return null;
  }

  return kitchen.location.coordinates;
}

/**
 * Localized nearby + trending + category cache invalidation for a kitchen.
 * Clears only geohash cells within delivery radius — never the whole city.
 */
async function invalidateNearbyCachesForKitchen(kitchenOrId, { logPrefix = '[cache]' } = {}) {
  const coords = await resolveKitchenCoords(kitchenOrId);
  const id = kitchenOrId?._id || kitchenOrId || 'unknown';

  if (!coords) {
    console.warn(`${logPrefix} Kitchen ${id} has no location; skipping nearby invalidation`);
    return { skipped: true };
  }

  const [lng, lat] = coords;

  try {
    const [nearby, trending, category] = await Promise.all([
      nearbyCache.invalidateAround(lat, lng),
      trendingCache.invalidateAround(lat, lng),
      categoryCache.invalidateAround(lat, lng),
    ]);
    return { skipped: false, nearby, trending, category };
  } catch (err) {
    console.warn(`${logPrefix} Localized cache invalidation failed:`, err.message);
    return { skipped: false, error: err.message };
  }
}

/**
 * Invalidate kitchen menu + localized nearby/trending/category caches after menu mutations.
 */
async function invalidateMenuAndNearby(kitchenId) {
  await menuCache.invalidate(kitchenId);
  await invalidateNearbyCachesForKitchen(kitchenId);
}

/**
 * Increment dish/kitchen popularity on delivery, then drop nearby + trending + category caches
 * so Home/See All/Category do not keep stale rankings or closed-kitchen cards.
 */
async function recordDeliveredOrderStats(order, { logPrefix = '[delivery]' } = {}) {
  if (!order) return { skipped: true };

  try {
    const itemOps = (order.items || [])
      .filter((item) => item.menuItemId && mongoose.Types.ObjectId.isValid(item.menuItemId))
      .map((item) => ({
        updateOne: {
          filter: { _id: item.menuItemId },
          update: { $inc: { totalOrders: item.qty || 1 } },
        },
      }));
    if (itemOps.length) {
      await MenuItem.bulkWrite(itemOps);
    }
    if (order.kitchenId) {
      await Kitchen.findByIdAndUpdate(order.kitchenId, { $inc: { totalOrders: 1 } });
    }
  } catch (statsErr) {
    console.error(`${logPrefix} Failed to increment order stats:`, statsErr.message);
  }

  try {
    await invalidateNearbyCachesForKitchen(order.kitchenId, { logPrefix });
  } catch (cacheErr) {
    console.warn(`${logPrefix} cache invalidation failed:`, cacheErr.message);
  }

  return { skipped: false };
}

module.exports = {
  resolveKitchenCoords,
  invalidateNearbyCachesForKitchen,
  invalidateMenuAndNearby,
  recordDeliveredOrderStats,
};
