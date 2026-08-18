const { parseCoords, parsePagination } = require('../utils/parseCoords');
const trendingCache = require('../services/trendingDishesCache.service');
const categoryCache = require('../services/categoryDishesCache.service');
const { resolveCategoryId } = require('../utils/categoryResolver');
const {
  fetchTrendingPool,
  paginateTrendingPool,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  POOL_CAP,
} = require('../services/trendingDishes.service');
const {
  fetchCategoryPool,
  paginateCategoryPool,
  DEFAULT_LIMIT: CATEGORY_DEFAULT_LIMIT,
  POOL_CAP: CATEGORY_POOL_CAP,
} = require('../services/categoryDishes.service');
const { CATEGORY_BY_ID } = require('../constants/menuCategories');

/**
 * GET /api/dishes/trending?lat=&lng=&page=1&limit=20
 * Top dishes capped at POOL_CAP (50), paginated 20 per page.
 */
const getTrendingDishes = async (req, res) => {
  try {
    const coords = parseCoords(req.query);
    if (!coords) {
      return res.status(400).json({
        success: false,
        message: 'Valid lat and lng query parameters are required.',
      });
    }

    const { page, limit } = parsePagination(req.query, {
      defaultLimit: DEFAULT_PAGE_LIMIT,
      maxLimit: MAX_PAGE_LIMIT,
    });
    const { latitude, longitude } = coords;

    let pool = await trendingCache.getPool(latitude, longitude);
    if (!pool) {
      pool = await fetchTrendingPool(latitude, longitude);
      await trendingCache.setPool(latitude, longitude, pool);
    }

    const { dishes, count, pagination } = paginateTrendingPool(pool, { page, limit });

    res.json({
      success: true,
      count,
      data: dishes,
      pagination,
      poolCap: POOL_CAP,
    });
  } catch (error) {
    console.error('getTrendingDishes error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/dishes/category/:categoryName?lat=&lng=&page=1&limit=20
 * Redis pool per ~550m cell + category; paginate in memory (multi-city safe).
 */
const getCategoryDishes = async (req, res) => {
  try {
    const coords = parseCoords(req.query);
    if (!coords) {
      return res.status(400).json({
        success: false,
        message: 'Valid lat and lng query parameters are required.',
      });
    }

    const { page, limit } = parsePagination(req.query, {
      defaultLimit: CATEGORY_DEFAULT_LIMIT,
    });
    const { latitude, longitude } = coords;
    const { categoryName } = req.params;

    const categoryId = resolveCategoryId(categoryName);
    if (!categoryId) {
      return res.status(400).json({
        success: false,
        message: `Unknown category "${categoryName}". Use a category id or label (e.g. thali, fastfood).`,
      });
    }

    let pool = await categoryCache.getPool(latitude, longitude, categoryId);
    if (!pool) {
      pool = await fetchCategoryPool(categoryId, latitude, longitude);
      await categoryCache.setPool(latitude, longitude, categoryId, pool);
    }

    const { dishes, pagination } = paginateCategoryPool(pool, { page, limit });
    const meta = CATEGORY_BY_ID[categoryId];

    res.json({
      success: true,
      count: dishes.length,
      data: {
        category: {
          id: categoryId,
          nameEn: meta?.nameEn || categoryId,
          nameHi: meta?.nameHi || categoryId,
        },
        dishes,
        pagination,
      },
      poolCap: CATEGORY_POOL_CAP,
    });
  } catch (error) {
    console.error('getCategoryDishes error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getTrendingDishes, getCategoryDishes };
