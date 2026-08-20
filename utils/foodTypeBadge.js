/**
 * Derive veg / non-veg / both badge from menu item type values.
 */
function deriveFoodTypeBadge(types) {
  const cleanTypes = (types || []).filter(Boolean);
  const hasNonVeg = cleanTypes.some((t) => t === 'nonveg' || t === 'non-veg');
  const hasVeg = cleanTypes.some((t) => t === 'veg');

  if (hasVeg && hasNonVeg) return 'both';
  if (hasNonVeg && !hasVeg) return 'non-veg';
  return 'veg';
}

async function loadFoodTypeBadgesByKitchen(MenuItem, kitchenIds) {
  if (!kitchenIds.length) return {};

  const rows = await MenuItem.aggregate([
    { $match: { kitchenId: { $in: kitchenIds } } },
    { $group: { _id: '$kitchenId', types: { $addToSet: '$type' } } },
  ]);

  const map = {};
  rows.forEach((row) => {
    map[row._id.toString()] = deriveFoodTypeBadge(row.types);
  });
  return map;
}

module.exports = { deriveFoodTypeBadge, loadFoodTypeBadgesByKitchen };
