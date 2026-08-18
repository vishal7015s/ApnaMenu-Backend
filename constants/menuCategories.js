/**
 * Single source of truth for menu item categories (seller + customer apps).
 */
const MENU_CATEGORIES = [
  {
    id: 'thali',
    nameEn: 'Thali',
    nameHi: 'थाली',
    icon: '🍱',
    imageUrl: 'https://res.cloudinary.com/dhoqrms16/image/upload/c_fill,w_250,q_auto:best,f_auto/v1783265331/thali_cutout_1783263586690-removebg-preview_ommkyx.png',
    sortOrder: 1,
  },
  {
    id: 'breakfast',
    nameEn: 'Breakfast',
    nameHi: 'नाश्ता',
    icon: '🍳',
    imageUrl: 'https://res.cloudinary.com/dhoqrms16/image/upload/c_fill,w_250,q_auto:best,f_auto/v1783265777/breakfast_cutout_1783263598748-removebg-preview_fmib2r.png',
    sortOrder: 2,
  },
  {
    id: 'fastfood',
    nameEn: 'Fast Food',
    nameHi: 'फास्ट फूड',
    icon: '🍕',
    imageUrl: 'https://res.cloudinary.com/dhoqrms16/image/upload/c_fill,w_250,q_auto:best,f_auto/v1783265776/fastfood_cutout_1783263621481-removebg-preview_weedzi.png',
    sortOrder: 3,
  },
  {
    id: 'combos',
    nameEn: 'Combos',
    nameHi: 'कॉम्बो',
    icon: '🥡',
    imageUrl: 'https://res.cloudinary.com/dhoqrms16/image/upload/c_fill,w_250,q_auto:best,f_auto/v1783265776/combos_cutout_1783263609516-removebg-preview_aiqtqc.png',
    sortOrder: 4,
  },
  {
    id: 'snacks',
    nameEn: 'Snacks',
    nameHi: 'स्नैक्स',
    icon: '🍿',
    imageUrl: null,
    sortOrder: 5,
  },
  {
    id: 'sweets',
    nameEn: 'Sweets',
    nameHi: 'मिठाई',
    icon: '🍬',
    imageUrl: 'https://res.cloudinary.com/dhoqrms16/image/upload/c_fill,w_250,q_auto:best,f_auto/v1783265776/sweets_cutout_1783263643430-removebg-preview_p7sx6x.png',
    sortOrder: 6,
  },
  {
    id: 'beverages',
    nameEn: 'Beverages',
    nameHi: 'पेय',
    icon: '🥤',
    imageUrl: null,
    sortOrder: 7,
  },
];

const MENU_CATEGORY_IDS = MENU_CATEGORIES.map((c) => c.id);

const CATEGORY_BY_ID = Object.fromEntries(MENU_CATEGORIES.map((c) => [c.id, c]));

module.exports = {
  MENU_CATEGORIES,
  MENU_CATEGORY_IDS,
  CATEGORY_BY_ID,
};
