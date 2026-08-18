const Kitchen = require('../models/Kitchen');
const MenuItem = require('../models/MenuItem');
const { customerVisibleKitchenFilter } = require('../utils/kitchenVisibility');
const { loadFoodTypeBadgesByKitchen } = require('../utils/foodTypeBadge');
const { toKitchenCardDto } = require('../utils/kitchenCardDto');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function buildPagination(page, limit, total) {
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
  };
}

function formatDistanceKm(distanceMeters) {
  return Number((distanceMeters / 1000).toFixed(1));
}

/**
 * All customer-visible kitchens within delivery radius, sorted nearest-first.
 * Used internally by trending/category dish scoping — lean projection only.
 */
async function getNearbyKitchenScope(latitude, longitude) {
  const { getMaxDeliveryDistanceKm } = require('../utils/deliveryPricing');
  const maxDistanceM = Math.round(getMaxDeliveryDistanceKm() * 1000);

  const kitchens = await Kitchen.aggregate([
    {
      $geoNear: {
        near: {
          type: 'Point',
          coordinates: [longitude, latitude],
        },
        distanceField: 'distance',
        maxDistance: maxDistanceM,
        spherical: true,
        query: customerVisibleKitchenFilter(),
      },
    },
    { $sort: { distance: 1 } },
    {
      $project: {
        name: 1,
        photo: 1,
        avgRating: 1,
        totalReviews: 1,
        isOpen: 1,
        distance: 1,
      },
    },
  ]);

  return kitchens.map((kitchen) => ({
    id: kitchen._id,
    distanceKm: formatDistanceKm(kitchen.distance),
    kitchen,
  }));
}

/**
 * Paginated nearby kitchens — lean card DTO for /kitchens/nearby and /home/feed.
 */
async function queryNearbyKitchens(latitude, longitude, options = {}) {
  const { getMaxDeliveryDistanceKm } = require('../utils/deliveryPricing');
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(options.limit, 10) || DEFAULT_LIMIT));
  const skip = (page - 1) * limit;
  const maxDistanceM = Math.round(getMaxDeliveryDistanceKm() * 1000);

  const [aggregateResult] = await Kitchen.aggregate([
    {
      $geoNear: {
        near: {
          type: 'Point',
          coordinates: [longitude, latitude],
        },
        distanceField: 'distance',
        maxDistance: maxDistanceM,
        spherical: true,
        query: customerVisibleKitchenFilter(),
      },
    },
    {
      $facet: {
        metadata: [{ $count: 'total' }],
        kitchens: [
          { $sort: { distance: 1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              name: 1,
              photo: 1,
              avgRating: 1,
              totalReviews: 1,
              isOpen: 1,
              distance: 1,
            },
          },
        ],
      },
    },
  ]);

  const total = aggregateResult?.metadata?.[0]?.total ?? 0;
  const kitchens = aggregateResult?.kitchens ?? [];
  const kitchenIds = kitchens.map((k) => k._id);

  const foodTypeMap = await loadFoodTypeBadgesByKitchen(MenuItem, kitchenIds);

  const enriched = kitchens.map((kitchen) => {
    const kId = kitchen._id.toString();
    return toKitchenCardDto(kitchen, {
      foodType: foodTypeMap[kId] || 'both',
      distanceKm: formatDistanceKm(kitchen.distance),
    });
  });

  return {
    kitchens: enriched,
    pagination: buildPagination(page, limit, total),
  };
}

module.exports = {
  queryNearbyKitchens,
  getNearbyKitchenScope,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildPagination,
};
