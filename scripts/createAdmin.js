// ====================================
// Create Super Admin Script
// Run: node scripts/createAdmin.js
// ====================================

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Admin = require('../models/Admin');

const createAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Check if admin already exists
    const existing = await Admin.findOne({ email: 'admin@apnamenu.com' });
    if (existing) {
      console.log('⚠️  Super Admin already exists!');
      console.log(`   Email: ${existing.email}`);
      console.log(`   Name: ${existing.name}`);
      console.log(`   Role: ${existing.role}`);
      process.exit(0);
    }

    // Create new super admin
    const admin = new Admin({
      email: 'admin@apnamenu.com',
      passwordHash: 'admin123', // Will be hashed by pre-save hook
      name: 'ApnaMenu Admin',
      role: 'superadmin',
    });

    await admin.save();

    console.log('\n🎉 Super Admin created successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Email:    admin@apnamenu.com`);
    console.log(`   Password: admin123`);
    console.log(`   Role:     superadmin`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
    process.exit(1);
  }
};

createAdmin();
