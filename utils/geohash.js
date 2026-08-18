/**
 * ~550m geohash grid for server-side cache keys.
 */
const GRID_STEP = 1 / 200; // 0.005° ≈ 550m

function snapToGridCoord(value) {
  return Math.round(Number(value) * 200) / 200;
}

function snapToGrid(lat, lng) {
  return {
    gridLat: snapToGridCoord(lat),
    gridLng: snapToGridCoord(lng),
  };
}

function geoCacheKey(lat, lng) {
  const { gridLat, gridLng } = snapToGrid(lat, lng);
  return `nearby:${gridLat}:${gridLng}`;
}

function geoPageCacheKey(lat, lng, page, limit, suffix = '') {
  const base = geoCacheKey(lat, lng);
  const extra = suffix ? `:${suffix}` : '';
  return `${base}:p${page}:l${limit}${extra}`;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180)
    * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Grid cells whose nearby-cache keys may include a kitchen at (lat, lng).
 * Covers delivery radius + half-cell snap buffer so edge users are included.
 */
function getAffectedGridCells(lat, lng, radiusKm) {
  const { getMaxDeliveryDistanceKm } = require('./deliveryPricing');
  const maxKm = radiusKm ?? getMaxDeliveryDistanceKm();
  const halfCellKm = 0.35;
  const thresholdKm = maxKm + halfCellKm;

  const kLat = Number(lat);
  const kLng = Number(lng);
  if (!Number.isFinite(kLat) || !Number.isFinite(kLng)) {
    return [];
  }

  const center = snapToGrid(kLat, kLng);
  const latDegPerKm = 1 / 111;
  const lngDegPerKm = 1 / (111 * Math.cos((kLat * Math.PI) / 180) || 1);
  const latDelta = thresholdKm * latDegPerKm;
  const lngDelta = thresholdKm * lngDegPerKm;

  const latSteps = Math.ceil(latDelta / GRID_STEP);
  const lngSteps = Math.ceil(lngDelta / GRID_STEP);

  const cells = [];
  const seen = new Set();

  for (let i = -latSteps; i <= latSteps; i++) {
    for (let j = -lngSteps; j <= lngSteps; j++) {
      const gridLat = snapToGridCoord(center.gridLat + i * GRID_STEP);
      const gridLng = snapToGridCoord(center.gridLng + j * GRID_STEP);
      const dedupeKey = `${gridLat}:${gridLng}`;
      if (seen.has(dedupeKey)) continue;

      if (haversineKm(kLat, kLng, gridLat, gridLng) <= thresholdKm) {
        seen.add(dedupeKey);
        cells.push({ gridLat, gridLng });
      }
    }
  }

  return cells;
}

module.exports = {
  GRID_STEP,
  snapToGrid,
  snapToGridCoord,
  geoCacheKey,
  geoPageCacheKey,
  haversineKm,
  getAffectedGridCells,
};
