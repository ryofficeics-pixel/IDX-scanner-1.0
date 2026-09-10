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
    client = new Redis({ url: REDIS_URL, token: REDIS_TOKEN, retry:false, signal:() => AbortSignal.timeout(1500) });
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

async function set(key, value, ttlSeconds = DEFAULT_TTL) {
  const r = getClient();
  if (!r) return value;
  try {
    const item = JSON.stringify({ _data: value, _savedAt: Date.now() });
    await r.set(PREFIX + key, item, { ex: ttlSeconds });
  } catch {}
  return value;
}

module.exports = { get, set, isAvailable: () => getClient() !== null };

async function getMany(keys, ttlMs) {
  const r = getClient();
  if (!r || !keys.length) return [];
  try {
    const items = await r.mget(...keys.map((key) => PREFIX + key));
    return items.map((raw) => typeof raw === 'string' ? JSON.parse(raw) : raw)
      .filter((item) => item && Date.now() - item._savedAt <= ttlMs).map((item) => item._data);
  } catch { return []; }
}

async function setMany(entries, ttlSeconds) {
  const r = getClient();
  if (!r || !entries.length) return;
  try {
    const batch = r.pipeline();
    for (const [key, value] of entries) batch.set(PREFIX + key, JSON.stringify({ _data:value, _savedAt:Date.now() }), { ex:ttlSeconds });
    await batch.exec();
  } catch { /* Optional state cannot prevent a scan response. */ }
}

Object.assign(module.exports, { getMany, setMany });
