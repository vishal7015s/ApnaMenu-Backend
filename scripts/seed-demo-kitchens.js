/**
 * Demo seed: ~40 kitchens within 7km + realistic menus (seller fields only).
 *
 * Run from backend/:
 *   node scripts/seed-demo-kitchens.js
 *
 * Safe: only removes previous demo owners (phones 9000000001–9000000040)
 * and their kitchens/menus. Does NOT wipe real kitchens.
 *
 * Base coords = Indore seed hub (same as seed.js). Put customer GPS near here.
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Kitchen = require('../models/Kitchen');
const MenuItem = require('../models/MenuItem');
const User = require('../models/User');

const BASE_LAT = 22.64325;
const BASE_LNG = 75.583028;
const DEMO_PHONE_PREFIX = '90000000'; // 9000000001 … 9000000040
const DEMO_COUNT = 40;

/** Unsplash / common CDN food & restaurant photos (not AI-generated). */
const KITCHEN_PHOTOS = {
  restaurant: [
    'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1466978913421-dad2ebd01d17?w=800&auto=format&fit=crop&q=80',
  ],
  pizza: [
    'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1593560708920-61dd98c46a4e?w=800&auto=format&fit=crop&q=80',
  ],
  tiffin: [
    'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1606491956689-2ea866880067?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800&auto=format&fit=crop&q=80',
  ],
  dhaba: [
    'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1626074353765-517a681e40be?w=800&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1505253758473-96b7015fcd40?w=800&auto=format&fit=crop&q=80',
  ],
};

const DISH_PHOTOS = {
  thali: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=600&auto=format&fit=crop&q=80',
  breakfast: 'https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?w=600&auto=format&fit=crop&q=80',
  fastfood: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&auto=format&fit=crop&q=80',
  pizza: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80',
  combos: 'https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=600&auto=format&fit=crop&q=80',
  snacks: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=600&auto=format&fit=crop&q=80',
  sweets: 'https://images.unsplash.com/photo-1571115177098-24ec42ed204d?w=600&auto=format&fit=crop&q=80',
  beverages: 'https://images.unsplash.com/photo-1544145945-f90425340c7e?w=600&auto=format&fit=crop&q=80',
  biryani: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80',
  burger: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&auto=format&fit=crop&q=80',
};

/** Offset km from base → GeoJSON [lng, lat]. Stay under ~6.5 km so 7km radius includes all. */
function offsetCoords(kmNorth, kmEast) {
  return [
    BASE_LNG + kmEast / 111.32,
    BASE_LAT + kmNorth / 110.574,
  ];
}

/** Spread 40 points in rings within 6.5 km. */
function ringOffset(index, total) {
  const ring = Math.floor(index / 10); // 0..3
  const slot = index % 10;
  const radiusKm = 1.2 + ring * 1.5; // ~1.2, 2.7, 4.2, 5.7
  const angle = (slot / 10) * Math.PI * 2 + ring * 0.35;
  return {
    kmNorth: Math.cos(angle) * radiusKm,
    kmEast: Math.sin(angle) * radiusKm,
  };
}

const KITCHENS = [
  // —— Restaurants (12) ——
  { kind: 'restaurant', name: 'Spice Garden Restaurant', ownerName: 'Anil Mehta' },
  { kind: 'restaurant', name: 'Royal Curry House', ownerName: 'Vikram Shah' },
  { kind: 'restaurant', name: 'The Indore Table', ownerName: 'Priya Joshi' },
  { kind: 'restaurant', name: 'Saffron Lounge', ownerName: 'Imran Khan' },
  { kind: 'restaurant', name: 'Urban Tadka Restaurant', ownerName: 'Neha Kapoor' },
  { kind: 'restaurant', name: 'Green Leaf Fine Dine', ownerName: 'Rohit Verma' },
  { kind: 'restaurant', name: 'Masala Street Kitchen', ownerName: 'Deepak Yadav' },
  { kind: 'restaurant', name: 'Coastal Spice Restaurant', ownerName: 'Suresh Nair' },
  { kind: 'restaurant', name: 'Heritage Thali Restaurant', ownerName: 'Kavita Sharma' },
  { kind: 'restaurant', name: 'Midnight Bistro', ownerName: 'Arjun Malhotra' },
  { kind: 'restaurant', name: 'Palm Court Dining', ownerName: 'Meena Iyer' },
  { kind: 'restaurant', name: 'Flame & Fork Restaurant', ownerName: 'Sanjay Gupta' },
  // —— Pizza centers (8) ——
  { kind: 'pizza', name: 'Slice Hub Pizza Center', ownerName: 'Rahul Jain' },
  { kind: 'pizza', name: 'Oven Fresh Pizza Co.', ownerName: 'Amit Patel' },
  { kind: 'pizza', name: 'Cheesy Crust Pizza', ownerName: 'Pooja Shah' },
  { kind: 'pizza', name: 'Napoli Express Pizza', ownerName: 'Marco Dias' },
  { kind: 'pizza', name: 'Box & Slice Pizza', ownerName: 'Kunal Agarwal' },
  { kind: 'pizza', name: 'Firewood Pizza Station', ownerName: 'Ritika Bose' },
  { kind: 'pizza', name: 'Quick Bite Pizza Center', ownerName: 'Harsh Vyas' },
  { kind: 'pizza', name: ' indore Pizza Lab', ownerName: 'Dev Sharma' },
  // —— Tiffin centers (10) ——
  { kind: 'tiffin', name: 'Ghar Ka Khana Tiffin', ownerName: 'Sunita Devi' },
  { kind: 'tiffin', name: 'Daily Dabba Tiffin Center', ownerName: 'Ramesh Patel' },
  { kind: 'tiffin', name: 'Maa Ki Rasoi Tiffin', ownerName: 'Geeta Bai' },
  { kind: 'tiffin', name: 'Office Tiffin Express', ownerName: 'Manoj Tiwari' },
  { kind: 'tiffin', name: 'Healthy Box Tiffin', ownerName: 'Ananya Rao' },
  { kind: 'tiffin', name: 'Sharma Tiffin Service', ownerName: 'Lalit Sharma' },
  { kind: 'tiffin', name: 'Student Meal Tiffin', ownerName: 'Kiran Soni' },
  { kind: 'tiffin', name: 'Annapurna Tiffin Center', ownerName: 'Pushpa Jain' },
  { kind: 'tiffin', name: 'Fresh Plate Tiffin', ownerName: 'Nitin Chouhan' },
  { kind: 'tiffin', name: 'Home Style Tiffin Hub', ownerName: 'Seema Rathore' },
  // —— Dhabas (10) ——
  { kind: 'dhaba', name: 'Punjabi Highway Dhaba', ownerName: 'Balwinder Singh' },
  { kind: 'dhaba', name: 'Chawla Dhaba', ownerName: 'Gurpreet Singh' },
  { kind: 'dhaba', name: 'Desi Tandoor Dhaba', ownerName: 'Jagdish Yadav' },
  { kind: 'dhaba', name: 'Truck Stop Dhaba', ownerName: 'Raju Bhai' },
  { kind: 'dhaba', name: 'Amritsari Handi Dhaba', ownerName: 'Harpreet Kaur' },
  { kind: 'dhaba', name: 'Lashkar Dhaba', ownerName: 'Imtiaz Ali' },
  { kind: 'dhaba', name: 'Sarhad Dhaba', ownerName: 'Parminder Singh' },
  { kind: 'dhaba', name: 'Star Dhaba Junction', ownerName: 'Mohit Rawat' },
  { kind: 'dhaba', name: 'Tandoori Nights Dhaba', ownerName: 'Firoz Khan' },
  { kind: 'dhaba', name: 'Grand Trunk Dhaba', ownerName: 'Sohan Lal' },
];

// Fix typo in pizza name
KITCHENS[19].name = 'Indore Pizza Lab';

function pickPhoto(kind, index) {
  const list = KITCHEN_PHOTOS[kind] || KITCHEN_PHOTOS.restaurant;
  return list[index % list.length];
}

function dish(category, name, price, prepTime, type, extras = {}) {
  const photoKey = extras.photoKey || category;
  return {
    name,
    price,
    originalPrice: extras.originalPrice ?? null,
    prepTime,
    category,
    type,
    inStock: extras.inStock !== false,
    description: extras.description || '',
    tags: extras.tags || [],
    photo: DISH_PHOTOS[photoKey] || DISH_PHOTOS[category] || DISH_PHOTOS.thali,
    totalOrders: extras.totalOrders ?? Math.floor(Math.random() * 80),
    rating: extras.rating ?? Number((3.5 + Math.random() * 1.4).toFixed(1)),
    totalReviews: extras.totalReviews ?? Math.floor(Math.random() * 40),
  };
}

/** Menus match seller add-item options: category + prepTime enum + veg/nonveg. */
function menuForKind(kind, kitchenName) {
  if (kind === 'pizza') {
    return [
      dish('fastfood', 'Margherita Pizza (Regular)', 149, 20, 'veg', { photoKey: 'pizza', originalPrice: 199 }),
      dish('fastfood', 'Farmhouse Pizza', 249, 30, 'veg', { photoKey: 'pizza' }),
      dish('fastfood', 'Chicken Pepperoni Pizza', 299, 30, 'nonveg', { photoKey: 'pizza' }),
      dish('fastfood', 'Garlic Breadsticks', 99, 15, 'veg', { photoKey: 'snacks' }),
      dish('combos', 'Pizza + Coke Combo', 199, 20, 'veg', { photoKey: 'combos', originalPrice: 249 }),
      dish('beverages', 'Cold Drink (500ml)', 40, 5, 'veg', { photoKey: 'beverages' }),
      dish('snacks', 'Cheesy Dip Fries', 89, 10, 'veg', { photoKey: 'snacks' }),
    ];
  }

  if (kind === 'tiffin') {
    return [
      dish('thali', 'Veg Executive Thali', 90, 20, 'veg', { tags: ['tiffin', 'lunch'] }),
      dish('thali', 'Mini Labour Thali', 60, 15, 'veg'),
      dish('thali', 'Dal Rice Special', 70, 15, 'veg'),
      dish('breakfast', 'Poha + Jalebi Box', 45, 10, 'veg', { photoKey: 'breakfast' }),
      dish('breakfast', 'Aloo Paratha (2 pcs)', 50, 15, 'veg'),
      dish('beverages', 'Chaas / Buttermilk', 20, 5, 'veg'),
      dish('sweets', 'Gulab Jamun (2 pcs)', 30, 5, 'veg', { photoKey: 'sweets' }),
      dish('combos', 'Full Day Tiffin (Lunch+Dinner)', 160, 30, 'veg', { photoKey: 'combos' }),
    ];
  }

  if (kind === 'dhaba') {
    return [
      dish('thali', 'Dhaba Special Thali', 120, 20, 'veg'),
      dish('thali', 'Butter Chicken + Naan', 180, 30, 'nonveg', { photoKey: 'biryani', originalPrice: 220 }),
      dish('thali', 'Dal Makhani + Roti', 110, 20, 'veg'),
      dish('fastfood', 'Paneer Tikka (6 pcs)', 140, 20, 'veg', { photoKey: 'fastfood' }),
      dish('fastfood', 'Tandoori Chicken Half', 200, 30, 'nonveg'),
      dish('snacks', 'Onion Pakora Plate', 60, 10, 'veg', { photoKey: 'snacks' }),
      dish('beverages', 'Lassi Sweet', 40, 5, 'veg'),
      dish('sweets', 'Gajar Halwa Cup', 50, 10, 'veg', { photoKey: 'sweets' }),
      dish('combos', 'Family Dhaba Combo', 450, 30, 'nonveg', { photoKey: 'combos' }),
    ];
  }

  // restaurant default
  return [
    dish('thali', `${kitchenName.split(' ')[0]} Veg Thali`, 130, 20, 'veg'),
    dish('thali', 'Chicken Biryani Bowl', 160, 30, 'nonveg', { photoKey: 'biryani' }),
    dish('thali', 'Paneer Butter Masala Meal', 150, 20, 'veg'),
    dish('breakfast', 'Masala Dosa Plate', 80, 15, 'veg', { photoKey: 'breakfast' }),
    dish('fastfood', 'Veg Burger', 70, 10, 'veg', { photoKey: 'burger' }),
    dish('fastfood', 'Chicken Wrap', 110, 15, 'nonveg', { photoKey: 'fastfood' }),
    dish('snacks', 'Samosa (2 pcs)', 30, 5, 'veg', { photoKey: 'snacks' }),
    dish('combos', 'Lunch Combo Meal', 199, 20, 'veg', { photoKey: 'combos', originalPrice: 249 }),
    dish('sweets', 'Rasmalai (2 pcs)', 60, 5, 'veg', { photoKey: 'sweets' }),
    dish('beverages', 'Fresh Lime Soda', 35, 5, 'veg', { photoKey: 'beverages' }),
  ];
}

function demoPhone(i) {
  return `${DEMO_PHONE_PREFIX}${String(i + 1).padStart(2, '0')}`;
}

async function clearPreviousDemo() {
  const phones = Array.from({ length: DEMO_COUNT }, (_, i) => demoPhone(i));
  const owners = await User.find({ phone: { $in: phones } }).select('_id phone');
  if (!owners.length) {
    console.log('No previous demo owners found.\n');
    return;
  }
  const ownerIds = owners.map((o) => o._id);
  const kitchens = await Kitchen.find({ ownerId: { $in: ownerIds } }).select('_id');
  const kitchenIds = kitchens.map((k) => k._id);
  if (kitchenIds.length) {
    await MenuItem.deleteMany({ kitchenId: { $in: kitchenIds } });
    await Kitchen.deleteMany({ _id: { $in: kitchenIds } });
  }
  await User.deleteMany({ _id: { $in: ownerIds } });
  console.log(`🗑️  Cleared ${kitchenIds.length} previous demo kitchens + owners.\n`);
}

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI missing in backend/.env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('✅ Connected to MongoDB\n');

  await clearPreviousDemo();

  if (KITCHENS.length !== DEMO_COUNT) {
    console.warn(`⚠️  Kitchen list has ${KITCHENS.length} entries (expected ${DEMO_COUNT}). Using list length.`);
  }

  const list = KITCHENS.slice(0, DEMO_COUNT);
  let menuTotal = 0;

  for (let i = 0; i < list.length; i++) {
    const def = list[i];
    const phone = demoPhone(i);
    const { kmNorth, kmEast } = ringOffset(i, list.length);

    const owner = await User.create({
      phone,
      name: def.ownerName,
      role: 'kitchen',
      activeRole: 'kitchen',
    });

    // A few closed shops for realistic UI
    const isOpen = i % 11 !== 0;

    const kitchen = await Kitchen.create({
      ownerId: owner._id,
      name: def.name,
      ownerName: def.ownerName,
      upiId: `demo${i + 1}@upi`,
      fssaiNumber: `1234567890${String(i + 1).padStart(4, '0')}`,
      photo: pickPhoto(def.kind, i),
      location: {
        type: 'Point',
        coordinates: offsetCoords(kmNorth, kmEast),
      },
      isOpen,
      verificationStatus: 'approved',
      verifiedAt: new Date(),
      accountStatus: 'active',
      avgRating: Number((3.6 + (i % 14) * 0.1).toFixed(1)),
      totalOrders: 20 + i * 3,
      totalReviews: 5 + (i % 20),
      totalEarnings: 1000 + i * 250,
    });

    const items = menuForKind(def.kind, def.name).map((item) => ({
      ...item,
      kitchenId: kitchen._id,
    }));
    await MenuItem.insertMany(items);
    menuTotal += items.length;

    const distApprox = Math.sqrt(kmNorth * kmNorth + kmEast * kmEast).toFixed(1);
    console.log(
      `  ${String(i + 1).padStart(2, '0')}. ${def.name} (${def.kind}) ~${distApprox}km · ${items.length} items · ${isOpen ? 'OPEN' : 'CLOSED'}`,
    );
  }

  console.log('\n═══════════════════════════════════════');
  console.log('✅ DEMO SEED COMPLETE');
  console.log('═══════════════════════════════════════');
  console.log(`🏠 Kitchens: ${list.length}`);
  console.log(`🍽️  Menu items: ${menuTotal}`);
  console.log(`📍 Hub (set customer GPS near): ${BASE_LAT}, ${BASE_LNG}`);
  console.log(`📱 Demo seller phones: ${demoPhone(0)} … ${demoPhone(list.length - 1)}`);
  console.log('═══════════════════════════════════════\n');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(async (err) => {
  console.error('❌ Seed failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
