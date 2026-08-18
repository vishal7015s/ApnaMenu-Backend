// ====================================
// Seed Script — Test Data for Development
// ====================================
// Run: node scripts/seed.js
// Uses coordinates near Indore (22.643250, 75.583028)

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Kitchen = require('../models/Kitchen');
const MenuItem = require('../models/MenuItem');
const User = require('../models/User');

const DEFAULT_KITCHEN_PHOTO =
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500&auto=format&fit=crop&q=80';
const DEFAULT_DISH_PHOTO =
  'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400&auto=format&fit=crop&q=80';

const KITCHEN_PHOTOS = [
  'https://res.cloudinary.com/dhoqrms16/image/upload/v1783073805/real-sharma-ji_otpcdq.jpg',
  'https://res.cloudinary.com/dhoqrms16/image/upload/v1783073804/real-maa-ki-rasoi_cz7gdx.jpg',
  'https://res.cloudinary.com/dhoqrms16/image/upload/v1783073804/ramu_ka_khana_az9tcg.jpg',
];

const INDORE_LAT = 22.643250;
const INDORE_LNG = 75.583028;

// Helper: offset coordinates slightly (within ~2KM)
const offset = (baseLat, baseLng, kmLat, kmLng) => [
  baseLng + (kmLng / 111.32),  // longitude first (GeoJSON format)
  baseLat + (kmLat / 110.574), // latitude second
];

const seedData = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB for seeding...\n');

    // Clear existing seed data
    await Kitchen.deleteMany({});
    await MenuItem.deleteMany({});
    console.log('🗑️  Cleared existing kitchens & menu items.\n');

    // Create a dummy owner user (or use existing)
    let owner1 = await User.findOne({ phone: '1111111111' });
    if (!owner1) {
      owner1 = await User.create({ phone: '1111111111', name: 'Ramesh Sharma', role: 'kitchen', activeRole: 'kitchen' });
    }
    let owner2 = await User.findOne({ phone: '2222222222' });
    if (!owner2) {
      owner2 = await User.create({ phone: '2222222222', name: 'Sunita Patel', role: 'kitchen', activeRole: 'kitchen' });
    }
    let owner3 = await User.findOne({ phone: '3333333333' });
    if (!owner3) {
      owner3 = await User.create({ phone: '3333333333', name: 'Ramu Bhai', role: 'kitchen', activeRole: 'kitchen' });
    }

    // ─── Kitchen 1: Sharma Ji Ka Kitchen (0.8 KM away) ───
    const k1 = await Kitchen.create({
      ownerId: owner1._id,
      name: 'Sharma Ji Ka Kitchen',
      ownerName: 'Ramesh Sharma',
      upiId: 'ramesh@paytm',
      fssaiNumber: '12345678901234',
      photo: KITCHEN_PHOTOS[0],
      location: { type: 'Point', coordinates: offset(INDORE_LAT, INDORE_LNG, 0.5, 0.3) },
      isOpen: true,
      avgRating: 4.5,
      totalOrders: 48,
      totalEarnings: 3840,
    });

    // ─── Kitchen 2: Dilli Ka Dabba (1.5 KM away) ───
    const k2 = await Kitchen.create({
      ownerId: owner2._id,
      name: 'Dilli Ka Dabba',
      ownerName: 'Sunita Patel',
      upiId: 'sunita@gpay',
      photo: KITCHEN_PHOTOS[1],
      location: { type: 'Point', coordinates: offset(INDORE_LAT, INDORE_LNG, -1.0, 0.8) },
      isOpen: true,
      avgRating: 4.1,
      totalOrders: 23,
      totalEarnings: 1840,
    });

    // ─── Kitchen 3: Ramu Bhai Khana (2.8 KM away) ───
    const k3 = await Kitchen.create({
      ownerId: owner3._id,
      name: 'Ramu Bhai Khana',
      ownerName: 'Ramu Bhai',
      upiId: 'ramu@phonepe',
      photo: KITCHEN_PHOTOS[2],
      location: { type: 'Point', coordinates: offset(INDORE_LAT, INDORE_LNG, 1.5, -1.8) },
      isOpen: true,
      avgRating: 4.3,
      totalOrders: 35,
      totalEarnings: 2800,
    });

    console.log('🏠 Created 3 kitchens.\n');

    // ─── Menu Items ───
    const withPhoto = (item) => ({ ...item, photo: item.photo || DEFAULT_DISH_PHOTO });
    const menuItems = [
      // Sharma Ji Ka Kitchen
      withPhoto({ kitchenId: k1._id, name: 'Maggi Special', price: 40, prepTime: 10, category: 'snacks', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k1._id, name: 'Standard Veg Thali', price: 80, prepTime: 20, category: 'thali', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k1._id, name: 'Poha Breakfast', price: 35, prepTime: 15, category: 'breakfast', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k1._id, name: 'Masala Chai', price: 15, prepTime: 5, category: 'beverages', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k1._id, name: 'Labour Thali', price: 60, prepTime: 20, category: 'thali', type: 'veg', inStock: true }),

      // Dilli Ka Dabba
      withPhoto({ kitchenId: k2._id, name: 'Chole Bhature', price: 50, prepTime: 15, category: 'fastfood', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k2._id, name: 'Rajma Chawal', price: 70, prepTime: 20, category: 'thali', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k2._id, name: 'Aloo Paratha', price: 30, prepTime: 10, category: 'breakfast', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k2._id, name: 'Lassi', price: 25, prepTime: 5, category: 'beverages', type: 'veg', inStock: true }),

      // Ramu Bhai Khana
      withPhoto({ kitchenId: k3._id, name: 'Egg Curry Rice', price: 65, prepTime: 15, category: 'thali', type: 'nonveg', inStock: true }),
      withPhoto({ kitchenId: k3._id, name: 'Chicken Biryani', price: 120, prepTime: 30, category: 'thali', type: 'nonveg', inStock: true }),
      withPhoto({ kitchenId: k3._id, name: 'Veg Biryani', price: 80, prepTime: 20, category: 'thali', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k3._id, name: 'Samosa (2 pcs)', price: 20, prepTime: 5, category: 'snacks', type: 'veg', inStock: true }),
      withPhoto({ kitchenId: k3._id, name: 'Gulab Jamun (3 pcs)', price: 30, prepTime: 5, category: 'sweets', type: 'veg', inStock: true }),
    ];

    await MenuItem.insertMany(menuItems);
    console.log(`🍽️  Inserted ${menuItems.length} menu items.\n`);

    console.log('═══════════════════════════════════════');
    console.log('✅ SEED COMPLETE!');
    console.log('═══════════════════════════════════════');
    console.log(`📍 Base coordinates: ${INDORE_LAT}, ${INDORE_LNG} (Indore)`);
    console.log(`🏠 Kitchens: ${k1.name}, ${k2.name}, ${k3.name}`);
    console.log(`🍽️  Total menu items: ${menuItems.length}`);
    console.log('═══════════════════════════════════════\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Seed error:', error.message);
    process.exit(1);
  }
};

seedData();
