const MenuItem = require('../models/MenuItem');
const { resolveCategoryId } = require('../utils/categoryResolver');
const { getNearbyKitchenScope, buildPagination } = require('./nearbyKitchens.service');
const { isKitchenCustomerVisible } = require('../utils/kitchenVisibility');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Soft cap so Redis values stay bounded in dense multi-city areas. */
const POOL_CAP = 200;

const DISH_SELECT =
  'name photo price originalPrice prepTime category type inStock totalOrders rating totalReviews kitchenId';

/**
 * Full sorted category dish list for a lat/lng cell (nearest kitchen → popularity).
 * Cached in Redis; paginated in-memory by the controller.
 */
async function fetchCategoryPool(categoryId, latitude, longitude) {
  const scope = await getNearbyKitchenScope(latitude, longitude);
  const kitchenIds = scope.map((row) => row.id);

  if (!kitchenIds.length) {
    return [];
  }

  const distanceRank = new Map(scope.map((row, index) => [row.id.toString(), index]));
  const distanceByKitchen = Object.fromEntries(
    scope.map((row) => [row.id.toString(), row.distanceKm]),
  );

  const rawItems = await MenuItem.find({
    kitchenId: { $in: kitchenIds },
    category: categoryId,
    inStock: true,
  })
    .select(DISH_SELECT)
    .populate('kitchenId', 'name photo avgRating isOpen accountStatus verificationStatus')
    .lean();

  const visible = rawItems.filter((item) => isKitchenCustomerVisible(item.kitchenId));

  visible.sort((a, b) => {
    const aKitchenId = (a.kitchenId?._id || a.kitchenId).toString();
    const bKitchenId = (b.kitchenId?._id || b.kitchenId).toString();
    const rankDiff = (distanceRank.get(aKitchenId) ?? 9999) - (distanceRank.get(bKitchenId) ?? 9999);
    if (rankDiff !== 0) return rankDiff;
    const ordersDiff = (b.totalOrders || 0) - (a.totalOrders || 0);
    if (ordersDiff !== 0) return ordersDiff;
    return a.name.localeCompare(b.name);
  });

  return visible.slice(0, POOL_CAP).map((dish) => {
    const kitchenId = dish.kitchenId?._id || dish.kitchenId;
    const kIdStr = kitchenId?.toString?.() || String(kitchenId);
    return {
      ...dish,
      distanceKm: distanceByKitchen[kIdStr] ?? null,
      kitchen: dish.kitchenId,
      kitchenId,
    };
  });
}

/**
 * Paginate a cached or freshly built category pool.
 */
function paginateCategoryPool(pool, { page = 1, limit = DEFAULT_LIMIT } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT));
  const total = Array.isArray(pool) ? pool.length : 0;
  const skip = (safePage - 1) * safeLimit;
  const dishes = (pool || []).slice(skip, skip + safeLimit);

  return {
    dishes,
    pagination: buildPagination(safePage, safeLimit, total),
  };
}

/**
 * Resolve category + load (uncached) pool page — prefer controller path with Redis.
 */
async function queryCategoryDishes(categoryName, latitude, longitude, { page = 1, limit = DEFAULT_LIMIT } = {}) {
  const categoryId = resolveCategoryId(categoryName);
  if (!categoryId) {
    return { error: 'INVALID_CATEGORY' };
  }

  const pool = await fetchCategoryPool(categoryId, latitude, longitude);
  const { dishes, pagination } = paginateCategoryPool(pool, { page, limit });

  return {
    category: categoryId,
    dishes,
    pagination,
  };
}

module.exports = {
  fetchCategoryPool,
  paginateCategoryPool,
  queryCategoryDishes,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  POOL_CAP,
};
