/**
 * Parse lat/lng from Express query/body. Returns null when invalid.
 */
function parseCoords(source) {
  const lat = source?.lat;
  const lng = source?.lng;
  if (
    lat == null || lng == null
    || lat === 'undefined' || lng === 'undefined'
    || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))
  ) {
    return null;
  }
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }
  return { latitude, longitude };
}

function parsePagination(query, { defaultLimit = 10, maxLimit = 50 } = {}) {
  const page = Math.max(1, parseInt(query?.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query?.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { parseCoords, parsePagination };
