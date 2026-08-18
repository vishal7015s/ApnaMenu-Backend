// ====================================
// MongoDB Atlas Connection
// ====================================

const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      // Connection pool — sized for 1000 concurrent riders
      maxPoolSize: 100,
      minPoolSize: 20,
      maxIdleTimeMS: 60000,          // Close idle connections after 60s
      serverSelectionTimeoutMS: 5000, // Fail fast if Atlas is unreachable
      socketTimeoutMS: 45000,         // Drop stalled socket operations after 45s
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
