const { MENU_CATEGORIES, MENU_CATEGORY_IDS } = require('../constants/menuCategories');

function normalizeCategoryToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * Resolve URL segment or label (e.g. "Fast Food", "fastfood", "thali") to category id.
 */
function resolveCategoryId(categoryName) {
  const token = normalizeCategoryToken(categoryName);
  if (!token) return null;

  if (MENU_CATEGORY_IDS.includes(token)) return token;

  const match = MENU_CATEGORIES.find((c) => {
    const idToken = normalizeCategoryToken(c.id);
    const enToken = normalizeCategoryToken(c.nameEn);
    const hiToken = normalizeCategoryToken(c.nameHi);
    return token === idToken || token === enToken || token === hiToken;
  });

  return match?.id || null;
}

module.exports = { resolveCategoryId, normalizeCategoryToken };
