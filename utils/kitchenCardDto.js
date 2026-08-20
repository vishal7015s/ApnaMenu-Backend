const DEFAULT_KITCHEN_PHOTO =
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500&auto=format&fit=crop&q=80';

/**
 * Lean kitchen card payload for home / see-all listings.
 * Excludes menu previews, addresses, owner/payout fields, and nested blobs.
 */
function toKitchenCardDto(kitchen, { foodType, distanceKm }) {
  const photo = kitchen.photo || DEFAULT_KITCHEN_PHOTO;
  const dist =
    distanceKm != null
      ? typeof distanceKm === 'number'
        ? distanceKm.toFixed(1)
        : String(distanceKm)
      : '0.0';
  const rating = kitchen.avgRating ?? kitchen.rating ?? 0;

  return {
    _id: kitchen._id,
    name: kitchen.name,
    photo,
    banner: photo,
    rating,
    avgRating: rating,
    totalReviews: kitchen.totalReviews ?? 0,
    distanceKm: dist,
    foodType: foodType || 'veg',
    isOpen: kitchen.isOpen !== false,
    isAcceptingOrders: kitchen.isOpen !== false,
  };
}

module.exports = { toKitchenCardDto, DEFAULT_KITCHEN_PHOTO };
