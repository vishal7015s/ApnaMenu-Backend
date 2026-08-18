// ====================================
// One-off repair script: fix Users who own a Kitchen but whose role/activeRole
// never got flipped to 'kitchen' in DB (caused by a since-fixed bug where
// req.user.save() crashed on cached (non-Mongoose) user objects during
// registerKitchen, right after the Kitchen document was already created).
// Run: node scripts/fix-kitchen-owner-roles.js
// ====================================

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Kitchen = require('../models/Kitchen');
const User = require('../models/User');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const kitchens = await Kitchen.find({}).select('ownerId name');
  console.log(`Found ${kitchens.length} kitchen(s).`);

  let fixed = 0;
  let alreadyOk = 0;
  let missingOwner = 0;

  for (const kitchen of kitchens) {
    const user = await User.findById(kitchen.ownerId);
    if (!user) {
      missingOwner++;
      console.warn(`  ! Kitchen "${kitchen.name}" (${kitchen._id}) has no matching User (ownerId ${kitchen.ownerId})`);
      continue;
    }

    if (user.role === 'kitchen' && user.activeRole === 'kitchen') {
      alreadyOk++;
      continue;
    }

    console.log(
      `  -> Fixing user ${user._id} (phone ${user.phone}): role=${user.role} activeRole=${user.activeRole} -> kitchen (owns "${kitchen.name}")`
    );
    user.role = 'kitchen';
    user.activeRole = 'kitchen';
    user.signupIntent = null;
    await user.save();
    fixed++;
  }

  console.log('\nDone.');
  console.log(`  Already correct: ${alreadyOk}`);
  console.log(`  Fixed:           ${fixed}`);
  console.log(`  Missing owner:   ${missingOwner}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
