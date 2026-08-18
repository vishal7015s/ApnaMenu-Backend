/**
 * Lean trending dish card payload for home / see-all listings.
 * Excludes galleries, descriptions, tags, reviews, and nested kitchen blobs.
 */
function toFoodTypeLabel(type) {
  if (type === 'nonveg') return 'non-veg';
  if (type === 'veg') return 'veg';
  return null;
}

function toTrendingDishCardDto(dish, { kitchenName, distanceKm, isOpen } = {}) {
  const kitchenId = dish.kitchenId?._id || dish.kitchenId;
  const foodType = toFoodTypeLabel(dish.type);

  return {
    _id: dish._id,
    name: dish.name,
    photo: dish.photo || '',
    kitchenId,
    kitchenName: kitchenName || dish.kitchenId?.name || '',
    prepTime: dish.prepTime,
    estimatedTime: dish.prepTime,
    foodType,
    type: dish.type,
    price: dish.price,
    originalPrice: dish.originalPrice ?? null,
    // Scalar card helpers (not nested/heavy)
    rating: dish.rating ?? 0,
    inStock: dish.inStock !== false,
    isOpen: isOpen !== false,
    distanceKm: distanceKm ?? null,
  };
}

module.exports = { toTrendingDishCardDto, toFoodTypeLabel };
