const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Kitchen = require('../models/Kitchen');
const MenuItem = require('../models/MenuItem');
const User = require('../models/User');

const INDORE_LAT = 22.643250;
const INDORE_LNG = 75.583028;

// Helper: offset coordinates slightly (within ~4KM)
const offset = (baseLat, baseLng, kmLat, kmLng) => [
  baseLng + (kmLng / 111.32),
  baseLat + (kmLat / 110.574),
];

const PHOTOS = [
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400&auto=format&fit=crop&q=80',
  'https://res.cloudinary.com/dhoqrms16/image/upload/v1783073805/real-sharma-ji_otpcdq.jpg',
  'https://res.cloudinary.com/dhoqrms16/image/upload/v1783073804/real-maa-ki-rasoi_cz7gdx.jpg',
  'https://res.cloudinary.com/dhoqrms16/image/upload/v1783073804/ramu_ka_khana_az9tcg.jpg'
];

const seedExtra = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB for seeding extra kitchens...\n');

    const newKitchensData = [
      { name: "Punjabi Tadka", ownerName: "Raj Singh", rating: 4.8, type: 'veg', isOpen: true },
      { name: "South Indian Express", ownerName: "Muthu", rating: 4.2, type: 'veg', isOpen: true },
      { name: "Biryani House", ownerName: "Abdul", rating: 4.6, type: 'nonveg', isOpen: true },
      { name: "Healthy Bites", ownerName: "Neha", rating: 4.0, type: 'veg', isOpen: false },
      { name: "Maa Ki Rasoi", ownerName: "Geeta Devi", rating: 4.9, type: 'veg', isOpen: true },
      { name: "Midnight Cravers", ownerName: "Karan", rating: 3.8, type: 'nonveg', isOpen: true },
      { name: "Street Food Wala", ownerName: "Bunty", rating: 4.3, type: 'veg', isOpen: true },
      { name: "Sweet Treats", ownerName: "Pooja", rating: 4.5, type: 'veg', isOpen: false },
      { name: "Noodles & More", ownerName: "Chen", rating: 4.1, type: 'nonveg', isOpen: true },
    ];

    for (let i = 0; i < newKitchensData.length; i++) {
      const data = newKitchensData[i];
      
      const phone = `88888888${i.toString().padStart(2, '0')}`;
      let owner = await User.findOne({ phone });
      if (!owner) {
        owner = await User.create({ phone, name: data.ownerName, role: 'kitchen', activeRole: 'kitchen' });
      }

      const k = await Kitchen.create({
        ownerId: owner._id,
        name: data.name,
        ownerName: data.ownerName,
        upiId: `mock${i}@upi`,
        photo: PHOTOS[i % PHOTOS.length],
        location: { type: 'Point', coordinates: offset(INDORE_LAT, INDORE_LNG, (Math.random() * 4) - 2, (Math.random() * 4) - 2) },
        isOpen: data.isOpen,
        avgRating: data.rating,
        totalOrders: Math.floor(Math.random() * 100) + 10,
        totalEarnings: 5000,
      });

      // Add 2 dishes for each
      await MenuItem.create([
        {
          kitchenId: k._id,
          name: `${data.name} Special Thali`,
          price: 150 + (i * 10),
          prepTime: 20,
          category: 'thali',
          type: data.type,
          photo: PHOTOS[(i + 1) % PHOTOS.length],
          rating: data.rating,
          inStock: true
        },
        {
          kitchenId: k._id,
          name: `Quick Snack ${i}`,
          price: 50 + (i * 5),
          prepTime: 10,
          category: 'snacks',
          type: data.type,
          photo: PHOTOS[(i + 2) % PHOTOS.length],
          rating: 4.0,
          inStock: data.isOpen // out of stock if closed for variety
        }
      ]);
    }

    console.log(`✅ Successfully seeded ${newKitchensData.length} new kitchens and their menu items!`);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
};

seedExtra();
