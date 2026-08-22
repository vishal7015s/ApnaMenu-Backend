const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Sign a JWT. `tv` must match User.tokenVersion or the token is rejected.
 */
function generateToken(userId, tokenVersion = 0) {
  return jwt.sign(
    { id: userId, tv: tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '90d' }
  );
}

function getTokenVersion(userOrDoc) {
  if (!userOrDoc) return 0;
  return typeof userOrDoc.tokenVersion === 'number' ? userOrDoc.tokenVersion : 0;
}

function tokenVersionMatches(decoded, user) {
  const tokenTv = decoded?.tv ?? 0;
  return tokenTv === getTokenVersion(user);
}

/**
 * Bump tokenVersion so all previously issued JWTs (and sockets) fail auth.
 * Returns the new version.
 */
async function bumpTokenVersion(userId) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { tokenVersion: 1 } },
    { new: true }
  ).select('tokenVersion');
  return getTokenVersion(user);
}

module.exports = {
  generateToken,
  getTokenVersion,
  tokenVersionMatches,
  bumpTokenVersion,
};
