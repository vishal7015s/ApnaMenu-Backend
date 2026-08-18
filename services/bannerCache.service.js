const Banner = require('../models/Banner');
const { cacheGet, cacheSet, cacheDel } = require('./cacheHelper.service');

const NAMESPACE = 'banner';
const KEY = 'banners:active';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — admin invalidates on save/delete

const BANNER_SELECT = 'title imageUrl order actionType actionData isActive';

async function fetchFromDb() {
  return Banner.find({ isActive: true })
    .sort({ order: 1 })
    .select(BANNER_SELECT)
    .lean();
}

async function getActive() {
  const cached = await cacheGet(NAMESPACE, KEY);
  if (cached) return cached;

  const banners = await fetchFromDb();
  await cacheSet(NAMESPACE, KEY, banners, TTL_MS);
  return banners;
}

async function invalidate() {
  return cacheDel(NAMESPACE, KEY);
}

module.exports = { getActive, invalidate, fetchFromDb, TTL_MS };
