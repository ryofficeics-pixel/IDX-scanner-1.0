'use strict';
const { Redis } = require('@upstash/redis');

const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.REDIS_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PREFIX = 'idxscan:';
const DEFAULT_TTL = 90;

let client = null;
function getClient() {
  if (client) return client;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    client = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
    return client;
  } catch {
    return null;
  }
}

async function get(key, ttlMs) {
  const r = getClient();
  if (!r) return null;
  try {
    const raw = await r.get(PREFIX + key);
    if (!raw) return null;
    const item = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const cacheAgeMs = Date.now() - (item._savedAt || 0);
    return { value: item._data, cacheAgeMs, stale: cacheAgeMs > ttlMs };
  } catch {
    return null;
  }
}

async function set(key, value) {
  const r = getClient();
  if (!r) return value;
  try {
    const item = JSON.stringify({ _data: value, _savedAt: Date.now() });
    await r.set(PREFIX + key, item, { ex: DEFAULT_TTL });
  } catch {}
  return value;
}

module.exports = { get, set, isAvailable: () => getClient() !== null };
