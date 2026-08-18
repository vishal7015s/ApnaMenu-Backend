#!/usr/bin/env node
/**
 * Wipe ApnaMenu MongoDB data — keeps Admin accounts (admins collection).
 *
 * Usage:
 *   node scripts/wipe-database.js --confirm
 *
 * Re-seed dev data (optional):
 *   node scripts/seed.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PRESERVE_COLLECTIONS = new Set(['admins']);

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.error('⚠️  This deletes ALL data except Admin accounts.');
    console.error('    Run again with --confirm:');
    console.error('    node scripts/wipe-database.js --confirm');
    process.exit(1);
  }

  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI not set in backend/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;

  console.log(`Connected to "${dbName}"\n`);

  const collections = await db.listCollections().toArray();
  if (collections.length === 0) {
    console.log('✅ Database is already empty.');
    await mongoose.disconnect();
    return;
  }

  let deletedTotal = 0;
  let preservedTotal = 0;

  for (const col of collections) {
    const name = col.name;
    const count = await db.collection(name).countDocuments();

    if (PRESERVE_COLLECTIONS.has(name)) {
      preservedTotal += count;
      console.log(`🔒 Kept ${name}: ${count} document(s)`);
      continue;
    }

    await db.collection(name).deleteMany({});
    deletedTotal += count;
    console.log(`🗑️  Cleared ${name}: ${count} document(s)`);
  }

  console.log(`\n✅ Done. Deleted ${deletedTotal} document(s); preserved ${preservedTotal} admin record(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Wipe failed:', err.message);
  process.exit(1);
});
