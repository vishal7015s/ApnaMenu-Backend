const MenuItem = require('../models/MenuItem');
const { getNearbyKitchenScope } = require('./nearbyKitchens.service');
const { isKitchenCustomerVisible } = require('../utils/kitchenVisibility');
const { toTrendingDishCardDto } = require('../utils/trendingDishCardDto');

/** Hard cap — max trending dishes available in an area. */
const POOL_CAP = 50;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 20;
const FETCH_BUFFER = 70;

/** Internal query fields — stripped before card DTO mapping. */
const DISH_SELECT =
  'name photo price originalPrice prepTime type inStock rating kitchenId totalOrders';

function buildPagination(page, limit, total) {
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
    poolCap: POOL_CAP,
  };
}

/**
 * Top dishes by totalOrders among nearby in-stock items (max POOL_CAP).
 * Returns lean card DTOs only.
 */
async function fetchTrendingPool(latitude, longitude) {
  const scope = await getNearbyKitchenScope(latitude, longitude);
  const kitchenIds = scope.map((row) => row.id);

  if (!kitchenIds.length) {
    return [];
  }

  const distanceByKitchen = Object.fromEntries(
    scope.map((row) => [row.id.toString(), row.distanceKm]),
  );

  const kitchenMetaById = Object.fromEntries(
    scope.map((row) => [
      row.id.toString(),
      { name: row.kitchen?.name, isOpen: row.kitchen?.isOpen },
    ]),
  );

  const dishes = await MenuItem.find({
    kitchenId: { $in: kitchenIds },
    inStock: true,
  })
    .select(DISH_SELECT)
    .sort({ totalOrders: -1, rating: -1, name: 1 })
    .limit(FETCH_BUFFER)
    .populate('kitchenId', 'name isOpen accountStatus verificationStatus')
    .lean();

  const visible = dishes.filter((dish) => isKitchenCustomerVisible(dish.kitchenId));

  return visible.slice(0, POOL_CAP).map((dish) => {
    const kitchenId = dish.kitchenId?._id || dish.kitchenId;
    const kIdStr = kitchenId?.toString?.() || String(kitchenId);
    const meta = kitchenMetaById[kIdStr] || {};

    return toTrendingDishCardDto(dish, {
      kitchenName: dish.kitchenId?.name || meta.name || '',
      distanceKm: distanceByKitchen[kIdStr] ?? null,
      isOpen: dish.kitchenId?.isOpen ?? meta.isOpen,
    });
  });
}

/**
 * Paginate a cached or freshly built trending pool.
 */
function paginateTrendingPool(pool, { page = 1, limit = DEFAULT_PAGE_LIMIT } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_LIMIT));
  const total = pool.length;
  const skip = (safePage - 1) * safeLimit;
  const pageDishes = pool.slice(skip, skip + safeLimit);

  return {
    dishes: pageDishes,
    count: pageDishes.length,
    pagination: buildPagination(safePage, safeLimit, total),
  };
}

/**
 * @deprecated Use fetchTrendingPool + paginateTrendingPool for paginated API.
 */
async function queryTrendingDishes(latitude, longitude, { page = 1, limit = DEFAULT_PAGE_LIMIT } = {}) {
  const pool = await fetchTrendingPool(latitude, longitude);
  return paginateTrendingPool(pool, { page, limit });
}

module.exports = {
  fetchTrendingPool,
  paginateTrendingPool,
  queryTrendingDishes,
  POOL_CAP,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  DEFAULT_LIMIT: DEFAULT_PAGE_LIMIT,
  MAX_LIMIT: MAX_PAGE_LIMIT,
};
