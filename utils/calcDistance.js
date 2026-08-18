/**
 * Calculates distance between two coordinates using Haversine formula.
 * Accepts (lat1, lon1, lat2, lon2) or GeoJSON-style [lng, lat] pairs via helpers.
 * @returns {number|null} Distance in km (1 decimal), or null if coords invalid
 */
function toRad(value) {
  return (value * Math.PI) / 180;
}

function isValidCoord(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

const calcDistance = (lat1, lon1, lat2, lon2) => {
  if (!isValidCoord(lat1, lon1) || !isValidCoord(lat2, lon2)) return null;

  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(1));
};

/** coords: [longitude, latitude] GeoJSON order */
function calcDistanceFromCoords(coordsA, coordsB) {
  if (!Array.isArray(coordsA) || !Array.isArray(coordsB)) return null;
  const [lon1, lat1] = coordsA;
  const [lon2, lat2] = coordsB;
  return calcDistance(lat1, lon1, lat2, lon2);
}

module.exports = { calcDistance, calcDistanceFromCoords };
