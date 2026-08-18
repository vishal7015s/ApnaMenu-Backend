/**
 * Derive veg / non-veg / both badge from menu item type values.
 */
function deriveFoodTypeBadge(types) {
  const set = new Set((types || []).filter(Boolean));
  const hasVeg = set.has('veg');
  const hasNonVeg = set.has('nonveg');

  if (hasVeg && hasNonVeg) return 'both';
  if (hasNonVeg) return 'non-veg';
  if (hasVeg) return 'veg';
  return 'both';
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
