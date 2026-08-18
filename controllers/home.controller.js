const nearbyCache = require('../services/nearbyCache.service');
const bannerCache = require('../services/bannerCache.service');
const { queryNearbyKitchens, DEFAULT_LIMIT } = require('../services/nearbyKitchens.service');
const { parseCoords } = require('../utils/parseCoords');

function buildHomeResponse(kitchens, banners, pagination) {
  return {
    success: true,
    count: kitchens.length,
    emptyState: kitchens.length === 0,
    data: {
      kitchens,
      banners,
      pagination,
    },
  };
}

/**
 * GET /api/home/feed?lat=&lng=
 * First page of nearby kitchens (with menu preview) + banners from long-TTL cache.
 */
const getHomeFeed = async (req, res) => {
  try {
    const coords = parseCoords(req.query);
    if (!coords) {
      return res.status(400).json({
        success: false,
        message: 'Valid lat and lng query parameters are required.',
      });
    }
    const { latitude, longitude } = coords;

    const [cachedKitchens, banners] = await Promise.all([
      nearbyCache.getHomeFeed(latitude, longitude),
      bannerCache.getActive(),
    ]);

    if (cachedKitchens?.data?.kitchens) {
      return res.json(buildHomeResponse(
        cachedKitchens.data.kitchens,
        banners,
        cachedKitchens.data.pagination,
      ));
    }

    const { kitchens, pagination } = await queryNearbyKitchens(latitude, longitude, {
      page: 1,
      limit: DEFAULT_LIMIT,
    });

    const kitchenPayload = {
      success: true,
      count: kitchens.length,
      emptyState: kitchens.length === 0,
      data: { kitchens, pagination },
    };

    await nearbyCache.setHomeFeed(latitude, longitude, kitchenPayload);

    res.json(buildHomeResponse(kitchens, banners, pagination));
  } catch (error) {
    console.error('getHomeFeed error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getHomeFeed };
