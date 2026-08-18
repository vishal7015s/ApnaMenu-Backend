// ====================================
// Menu Controller — Full Implementation
// ====================================

const MenuItem = require('../models/MenuItem');
const Kitchen = require('../models/Kitchen');
const { validateMenuPrice, validateOriginalPrice, validateMenuItemTextFields } = require('../utils/validation');
const menuCache = require('../services/menuCache.service');
const { invalidateMenuAndNearby } = require('../services/cacheInvalidation.service');
const dishReviewCache = require('../services/dishReviewCache.service');
const { MENU_CATEGORIES, MENU_CATEGORY_IDS } = require('../constants/menuCategories');
const { customerVisibleKitchenFilter, isKitchenCustomerVisible } = require('../utils/kitchenVisibility');
const { getMaxDeliveryDistanceKm } = require('../utils/deliveryPricing');

const SELLER_MENU_PAGE_SIZE = 20;
const SELLER_MENU_LIST_FIELDS = 'name photo price originalPrice prepTime category type inStock';

/** Map legacy category ids so old docs can still be edited/toggled. */
const LEGACY_CATEGORY_MAP = {
  lunch: 'thali',
  dinner: 'thali',
  desserts: 'sweets',
  dessert: 'sweets',
  combo: 'combos',
  other: 'snacks',
};

function normalizeCategoryId(category) {
  const id = String(category || '').toLowerCase().trim();
  if (!id) return null;
  if (MENU_CATEGORY_IDS.includes(id)) return id;
  if (LEGACY_CATEGORY_MAP[id]) return LEGACY_CATEGORY_MAP[id];
  return null;
}

/**
 * Notify customers so React Query discovery caches can patch/invalidate.
 * Emits both event names — client listens on either via useKitchenRealtimeSync.
 */
const emitMenuDishUpdated = (io, payload) => {
  if (!io || !payload) return;
  io.emit('dish:updated', payload);
  io.emit('menu:updated', payload);
};

const resolveKitchenIdForUser = async (user) => {
  if (user.kitchenId) return user.kitchenId;
  const kitchen = await Kitchen.findOne({ ownerId: user._id }).select('_id').lean();
  return kitchen?._id || null;
};

const collectMenuItemPublicIds = (item) => {
  const ids = [];
  if (item?.photoPublicId) ids.push(item.photoPublicId);
  (item?.photos || []).forEach((p) => {
    if (p?.publicId) ids.push(p.publicId);
  });
  return ids;
};

const deleteMenuItemAssets = async (item) => {
  const { deleteImage } = require('../config/cloudinary');
  const ids = [...new Set(collectMenuItemPublicIds(item))];
  await Promise.all(ids.map((id) => deleteImage(id)));
};

const normalizePhotoPayload = async (photosInput) => {
  if (!Array.isArray(photosInput) || photosInput.length === 0) return [];
  const { uploadImage } = require('../config/cloudinary');
  const uploadJobs = photosInput.slice(0, 5).map(async (p) => {
    if (typeof p === 'string' && p.startsWith('data:image')) {
      const uploadRes = await uploadImage(p, 'apnamenu/menu');
      return { url: uploadRes.url, publicId: uploadRes.publicId || '' };
    }
    if (typeof p === 'string' && (p.startsWith('http') || p.startsWith('/'))) {
      return { url: p, publicId: '' };
    }
    if (p && typeof p === 'object' && p.url) {
      return { url: p.url, publicId: p.publicId || '' };
    }
    return null;
  });
  return (await Promise.all(uploadJobs)).filter(Boolean);
};

const applyMainPhotoUpdate = async (item, photo) => {
  if (!photo || typeof photo !== 'string') return;
  const { uploadImage, deleteImage } = require('../config/cloudinary');
  if (photo.startsWith('data:image')) {
    if (item.photoPublicId) {
      await deleteImage(item.photoPublicId);
    }
    const uploadRes = await uploadImage(photo, 'apnamenu/menu');
    item.photo = uploadRes.url;
    item.photoPublicId = uploadRes.publicId;
    return;
  }
  if (photo.startsWith('http') || photo.startsWith('/')) {
    item.photo = photo;
  }
};

/**
 * POST /api/menu/item
 * Add a new menu item (kitchen owner)
 */
const addItem = async (req, res) => {
  try {
    const kitchen = await Kitchen.findOne({ ownerId: req.user._id });
    if (!kitchen) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    const { name, price, originalPrice, prepTime, category, type, photo, photoPublicId, photos, description, tags } = req.body;

    if (!name || price == null || !prepTime || !category) {
      return res.status(400).json({
        success: false,
        message: 'name, price, prepTime, and category are required.',
      });
    }

    const normalizedCategory = normalizeCategoryId(category);
    if (!normalizedCategory) {
      return res.status(400).json({
        success: false,
        message: `Invalid category. Allowed: ${MENU_CATEGORY_IDS.join(', ')}`,
      });
    }

    const textCheck = validateMenuItemTextFields(
      { name, description: description ?? '', tags: tags ?? [] },
      { nameRequired: true }
    );
    if (!textCheck.ok) {
      return res.status(400).json({ success: false, message: textCheck.message });
    }

    const priceCheck = validateMenuPrice(price);
    if (!priceCheck.ok) {
      return res.status(400).json({ success: false, message: priceCheck.message });
    }

    const origCheck = validateOriginalPrice(priceCheck.value, originalPrice);
    if (!origCheck.ok) {
      return res.status(400).json({ success: false, message: origCheck.message });
    }

    if (!photo || typeof photo !== 'string' || (!photo.startsWith('data:image') && !photo.startsWith('http'))) {
      return res.status(400).json({ success: false, message: 'A valid photo is required.' });
    }

    let finalPhotoUrl = photo || '';
    let finalPhotoPublicId = photoPublicId || '';

    if (photo.startsWith('data:image')) {
      const { uploadImage } = require('../config/cloudinary');
      try {
        const uploadRes = await uploadImage(photo, 'apnamenu/menu');
        finalPhotoUrl = uploadRes.url;
        finalPhotoPublicId = uploadRes.publicId;
      } catch (err) {
        return res.status(400).json({ success: false, message: 'Image upload failed. Please try again.' });
      }
    }

    let finalPhotos = [];
    if (Array.isArray(photos) && photos.length > 0) {
      finalPhotos = await normalizePhotoPayload(photos);
    }

    const item = await MenuItem.create({
      kitchenId: kitchen._id,
      name: textCheck.value.name,
      price: priceCheck.value,
      originalPrice: origCheck.value,
      prepTime,
      category: normalizedCategory,
      type: type || undefined, // Optional — only set when the seller explicitly picks Veg/Non-Veg
      photo: finalPhotoUrl,
      photoPublicId: finalPhotoPublicId,
      photos: finalPhotos,
      description: textCheck.value.description ?? '',
      tags: textCheck.value.tags ?? [],
    });

    await invalidateMenuAndNearby(kitchen._id);

    emitMenuDishUpdated(req.app.get('io'), {
      kitchenId: String(kitchen._id),
      dishId: String(item._id),
      action: 'add',
      name: item.name,
      price: item.price,
      inStock: item.inStock,
    });

    res.status(201).json({
      success: true,
      message: 'Menu item added!',
      data: item,
    });
  } catch (error) {
    console.error('addItem error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/menu/item/:id
 * Update a menu item
 */
const updateItem = async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found.' });
    }

    // Verify ownership
    const kitchen = await Kitchen.findOne({ _id: item.kitchenId, ownerId: req.user._id });
    if (!kitchen) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const { name, price, originalPrice, prepTime, category, type, photo, photoPublicId, photos, description, tags } = req.body;
    const oldPublicIds = collectMenuItemPublicIds(item);

    const textCheck = validateMenuItemTextFields({
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });
    if (!textCheck.ok) {
      return res.status(400).json({ success: false, message: textCheck.message });
    }
    if (textCheck.value.name !== undefined) item.name = textCheck.value.name;
    if (textCheck.value.description !== undefined) item.description = textCheck.value.description;
    if (textCheck.value.tags !== undefined) item.tags = textCheck.value.tags;

    if (price !== undefined) {
      const priceCheck = validateMenuPrice(price);
      if (!priceCheck.ok) {
        return res.status(400).json({ success: false, message: priceCheck.message });
      }
      item.price = priceCheck.value;
    }
    const nextOriginalPrice = originalPrice !== undefined ? originalPrice : item.originalPrice;
    const origCheck = validateOriginalPrice(item.price, nextOriginalPrice);
    if (!origCheck.ok) {
      return res.status(400).json({ success: false, message: origCheck.message });
    }
    item.originalPrice = origCheck.value;
    if (prepTime !== undefined) item.prepTime = prepTime;
    if (category) {
      const normalizedCategory = normalizeCategoryId(category);
      if (!normalizedCategory) {
        return res.status(400).json({
          success: false,
          message: `Invalid category. Allowed: ${MENU_CATEGORY_IDS.join(', ')}`,
        });
      }
      item.category = normalizedCategory;
    } else if (item.category && !MENU_CATEGORY_IDS.includes(item.category)) {
      // Auto-heal legacy category so save/toggle doesn't 500 on enum validation
      const healed = normalizeCategoryId(item.category);
      if (healed) item.category = healed;
      else {
        return res.status(400).json({
          success: false,
          message: 'This item has an outdated category. Please pick a valid category and save again.',
        });
      }
    }
    if (type !== undefined) item.type = type || undefined; // Optional — '' from the client clears it
    if (typeof photo === 'string' && photo.startsWith('data:image')) {
      try {
        await applyMainPhotoUpdate(item, photo);
      } catch (err) {
        return res.status(400).json({ success: false, message: 'Image upload failed. Please try again.' });
      }
    } else if (typeof photo === 'string') {
      item.photo = photo;
    } else if (photo && typeof photo === 'object' && photo.url) {
      // Backward-compat if an older client still sends {url, publicId}
      item.photo = photo.url;
      if (photo.publicId) item.photoPublicId = photo.publicId;
    }

    if (photoPublicId !== undefined && !(typeof photo === 'string' && photo.startsWith('data:image'))) {
      item.photoPublicId = photoPublicId;
    }

    if (Array.isArray(photos)) {
      item.photos = await normalizePhotoPayload(photos);
    }

    await item.save();

    const newPublicIds = new Set(collectMenuItemPublicIds(item));
    const { deleteImage } = require('../config/cloudinary');
    const orphanedIds = oldPublicIds.filter((id) => !newPublicIds.has(id));
    await Promise.all(orphanedIds.map((id) => deleteImage(id)));

    await invalidateMenuAndNearby(item.kitchenId);
    await dishReviewCache.invalidate(item._id);

    emitMenuDishUpdated(req.app.get('io'), {
      kitchenId: String(item.kitchenId),
      dishId: String(item._id),
      action: 'edit',
      name: item.name,
      price: item.price,
      inStock: item.inStock,
    });

    res.json({ success: true, message: 'Item updated!', data: item });
  } catch (error) {
    console.error('updateItem error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/menu/item/:id/toggle-stock
 * Toggle item in/out of stock
 */
const toggleStock = async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found.' });
    }

    const kitchen = await Kitchen.findOne({ _id: item.kitchenId, ownerId: req.user._id });
    if (!kitchen) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    // Heal legacy category before save so enum validation does not fail
    if (item.category && !MENU_CATEGORY_IDS.includes(item.category)) {
      const healed = normalizeCategoryId(item.category);
      if (healed) item.category = healed;
    }

    item.inStock = !item.inStock;
    await item.save();

    await invalidateMenuAndNearby(item.kitchenId);

    emitMenuDishUpdated(req.app.get('io'), {
      kitchenId: String(item.kitchenId),
      dishId: String(item._id),
      action: 'toggle',
      inStock: item.inStock,
    });

    res.json({
      success: true,
      message: `${item.name} is now ${item.inStock ? 'In Stock' : 'Out of Stock'}`,
      data: { inStock: item.inStock },
    });
  } catch (error) {
    console.error('toggleStock error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/menu/item/:id
 * Delete a menu item
 */
const deleteItem = async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found.' });
    }

    const kitchen = await Kitchen.findOne({ _id: item.kitchenId, ownerId: req.user._id });
    if (!kitchen) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const kitchenId = item.kitchenId;
    const itemId = item._id;
    // Delete DB row first so a Cloudinary failure cannot leave a broken orphan listing
    await item.deleteOne();
    await deleteMenuItemAssets(item).catch((err) => {
      console.warn('[deleteItem] cloudinary cleanup failed:', err?.message || err);
    });

    await invalidateMenuAndNearby(kitchenId);
    await dishReviewCache.invalidate(itemId);

    emitMenuDishUpdated(req.app.get('io'), {
      kitchenId: String(kitchenId),
      dishId: String(itemId),
      action: 'delete',
    });

    res.json({ success: true, message: 'Item deleted.' });
  } catch (error) {
    console.error('deleteItem error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/kitchens/:kitchenId/menu
 * GET /api/menu/kitchen/:kitchenId/items
 *
 * Customer kitchen menu.
 * - With ?page=&limit= → paginated flat `items` (default page=1, limit=10)
 * - Without page/limit → legacy full `menuByCategory` payload (backward compatible)
 */
const getKitchenMenu = async (req, res) => {
  try {
    const { kitchenId } = req.params;
    const hasPaging = req.query.page != null || req.query.limit != null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const kitchenMeta = await Kitchen.findById(kitchenId)
      .select('name ownerName photo avgRating totalOrders totalReviews isOpen location accountStatus verificationStatus')
      .lean();

    if (!kitchenMeta) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    if (!isKitchenCustomerVisible(kitchenMeta)) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    let cached = await menuCache.get(kitchenId);
    let allItems;
    let kitchen = kitchenMeta;

    if (cached?.items && Array.isArray(cached.items)) {
      allItems = cached.items;
      kitchen = cached.kitchen || kitchenMeta;
    } else if (cached?.menuByCategory && typeof cached.menuByCategory === 'object') {
      // Migrate legacy cache shape → flat list
      allItems = Object.keys(cached.menuByCategory)
        .sort()
        .flatMap((cat) => (Array.isArray(cached.menuByCategory[cat]) ? cached.menuByCategory[cat] : []));
      kitchen = cached.kitchen || kitchenMeta;
      await menuCache.set(kitchenId, {
        kitchen,
        items: allItems,
        totalItems: allItems.length,
      });
    } else {
      allItems = await MenuItem.find({ kitchenId })
        .select('name photo price originalPrice prepTime time category type inStock rating totalReviews')
        .sort({ category: 1, name: 1 })
        .lean();

      await menuCache.set(kitchenId, {
        kitchen: kitchenMeta,
        items: allItems,
        totalItems: allItems.length,
      });
    }

    if (!hasPaging) {
      // Legacy response for older clients / seller tooling
      const grouped = {};
      allItems.forEach((item) => {
        if (!grouped[item.category]) grouped[item.category] = [];
        grouped[item.category].push(item);
      });
      return res.json({
        success: true,
        data: {
          kitchen,
          menuByCategory: grouped,
          totalItems: allItems.length,
        },
      });
    }

    const total = allItems.length;
    const skip = (page - 1) * limit;
    const items = allItems.slice(skip, skip + limit);

    return res.json({
      success: true,
      data: {
        kitchen: page === 1 ? kitchen : undefined,
        items,
        totalItems: total,
        pagination: {
          page,
          limit,
          total,
          hasMore: skip + items.length < total,
        },
      },
    });
  } catch (error) {
    console.error('getKitchenMenu error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/menu/kitchen
 * Paginated menu list for logged-in kitchen owner (slim fields)
 */
const getMyKitchenMenu = async (req, res) => {
  try {
    const kitchenId = await resolveKitchenIdForUser(req.user);
    if (!kitchenId) {
      return res.status(404).json({ success: false, message: 'Kitchen not found.' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || SELLER_MENU_PAGE_SIZE));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      MenuItem.find({ kitchenId })
        .select(SELLER_MENU_LIST_FIELDS)
        .sort({ category: 1, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MenuItem.countDocuments({ kitchenId }),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + items.length < total,
      },
    });
  } catch (error) {
    console.error('getMyKitchenMenu error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/menu/item/:id
 * Full menu item detail for seller edit form
 */
const getMyMenuItem = async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.id).lean();
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found.' });
    }

    const kitchen = await Kitchen.findOne({ _id: item.kitchenId, ownerId: req.user._id }).select('_id').lean();
    if (!kitchen) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    res.json({ success: true, data: item });
  } catch (error) {
    console.error('getMyMenuItem error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/menu/search?query=XX&lat=XX&lng=XX
 * Search menu items across kitchens within 7KM
 */
const searchMenu = async (req, res) => {
  try {
    const { query, lat, lng } = req.query;

    if (!query) {
      return res.status(400).json({ success: false, message: 'query parameter is required.' });
    }

    // First find kitchens within 7KM
    let kitchenFilter = {};
    if (lat && lng) {
      const nearbyKitchens = await Kitchen.find(
        customerVisibleKitchenFilter({
          location: {
            $nearSphere: {
              $geometry: {
                type: 'Point',
                coordinates: [parseFloat(lng), parseFloat(lat)],
              },
              $maxDistance: Math.round(getMaxDeliveryDistanceKm() * 1000),
            },
          },
        })
      ).select('_id name').lean();

      const kitchenIds = nearbyKitchens.map(k => k._id);
      kitchenFilter = { kitchenId: { $in: kitchenIds } };
    }

    // Search menu items by name (case-insensitive regex)
    const items = await MenuItem.find({
      ...kitchenFilter,
      name: { $regex: query, $options: 'i' },
    })
      .populate('kitchenId', 'name photo avgRating location isOpen')
      .select('name photo price originalPrice prepTime category type inStock kitchenId rating totalReviews')
      .limit(20)
      .lean();

    res.json({
      success: true,
      count: items.length,
      data: items,
    });
  } catch (error) {
    console.error('searchMenu error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/menu/dish/:dishId
 * Get detailed dish info with kitchen data and review stats
 */
const getDishDetail = async (req, res) => {
  try {
    const { dishId } = req.params;
    const Rating = require('../models/Rating');

    const dish = await MenuItem.findById(dishId)
      .populate('kitchenId', 'name ownerName photo avgRating totalOrders isOpen location accountStatus verificationStatus')
      .lean();

    if (!dish) {
      return res.status(404).json({ success: false, message: 'Dish not found.' });
    }

    if (!isKitchenCustomerVisible(dish.kitchenId)) {
      return res.status(404).json({ success: false, message: 'Dish not found.' });
    }

    // Get all photos: combine primary photo + photos array
    let allPhotos = [];
    if (dish.photos && dish.photos.length > 0) {
      allPhotos = dish.photos.map(p => p.url);
    }
    if (dish.photo && !allPhotos.includes(dish.photo)) {
      allPhotos.unshift(dish.photo);
    }

    // Review stats via aggregation (avoid loading all rating docs)
    let reviewStats = await dishReviewCache.get(dishId);
    if (!reviewStats) {
      const [statsAgg, distAgg] = await Promise.all([
        Rating.aggregate([
          { $match: { menuItemId: dish._id } },
          {
            $group: {
              _id: null,
              totalReviews: { $sum: 1 },
              avgRating: {
                $avg: {
                  $cond: [
                    { $gt: [{ $ifNull: ['$foodRating', 0] }, 0] },
                    '$foodRating',
                    { $ifNull: ['$kitchenRating', 0] },
                  ],
                },
              },
            },
          },
        ]),
        Rating.aggregate([
          { $match: { menuItemId: dish._id } },
          {
            $project: {
              star: {
                $round: {
                  $cond: [
                    { $gt: [{ $ifNull: ['$foodRating', 0] }, 0] },
                    '$foodRating',
                    { $ifNull: ['$kitchenRating', 0] },
                  ],
                },
              },
            },
          },
          { $match: { star: { $gte: 1, $lte: 5 } } },
          { $group: { _id: '$star', count: { $sum: 1 } } },
        ]),
      ]);

      const totalReviews = statsAgg[0]?.totalReviews || 0;
      const avgRating = totalReviews > 0 ? Number(statsAgg[0].avgRating).toFixed(1) : 0;

      const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      distAgg.forEach((row) => {
        if (row._id >= 1 && row._id <= 5) distribution[row._id] = row.count;
      });

      reviewStats = {
        avgRating: parseFloat(avgRating),
        totalReviews,
        distribution,
      };
      await dishReviewCache.set(dishId, reviewStats);
    }

    const { avgRating, totalReviews, distribution } = reviewStats;

    // Calculate discount percentage
    let discountPercent = 0;
    if (dish.originalPrice && dish.originalPrice > dish.price) {
      discountPercent = Math.round(((dish.originalPrice - dish.price) / dish.originalPrice) * 100);
    }

    res.json({
      success: true,
      data: {
        dish: {
          ...dish,
          allPhotos,
          discountPercent,
        },
        reviewStats: {
          avgRating: parseFloat(avgRating),
          totalReviews,
          distribution,
        },
      },
    });
  } catch (error) {
    console.error('getDishDetail error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/menu/dish/:dishId/reviews?page=1&limit=10
 * Get paginated reviews for a dish
 */
const getDishReviews = async (req, res) => {
  try {
    const { dishId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const Rating = require('../models/Rating');

    const dish = await MenuItem.findById(dishId).select('kitchenId').lean();
    if (!dish) {
      return res.status(404).json({ success: false, message: 'Dish not found.' });
    }

    let filter = { menuItemId: dish._id };
    let total = await Rating.countDocuments(filter);

    const reviews = await Rating.find(filter)
      .populate('customerId', 'name phone avatar')
      .select('kitchenRating foodRating riderRating feedback photos helpfulCount createdAt customerId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: reviews,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getDishReviews error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/menu/dish/:dishId/reviews/:reviewId/helpful
 * Mark a review as helpful
 */
const markReviewHelpful = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const Rating = require('../models/Rating');

    const review = await Rating.findById(reviewId);
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found.' });
    }

    review.helpfulCount = (review.helpfulCount || 0) + 1;
    await review.save();

    res.json({ success: true, helpfulCount: review.helpfulCount });
  } catch (error) {
    console.error('markReviewHelpful error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/menu/categories
 * Public list of menu categories for seller + customer apps.
 */
const getMenuCategories = (req, res) => {
  const lang = req.query.lang === 'hi' ? 'hi' : 'en';
  const data = [...MENU_CATEGORIES]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({
      id: c.id,
      key: c.id,
      label: lang === 'hi' ? c.nameHi : c.nameEn,
      name: lang === 'hi' ? c.nameHi : c.nameEn,
      nameEn: c.nameEn,
      nameHi: c.nameHi,
      icon: c.icon,
      img: c.imageUrl || null,
      sortOrder: c.sortOrder,
    }));

  res.json({ success: true, data });
};

module.exports = {
  addItem, updateItem, toggleStock,
  deleteItem, getKitchenMenu, getMyKitchenMenu, getMyMenuItem, searchMenu,
  getDishDetail, getDishReviews, markReviewHelpful, getMenuCategories,
};
