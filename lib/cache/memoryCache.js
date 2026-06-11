'use strict';

const store = new Map();

function get(key, ttlMs) {
  const item = store.get(key);
  if (!item) return null;
  const cacheAgeMs = Date.now() - item.savedAt;
  if (cacheAgeMs > ttlMs) return { value:item.value, cacheAgeMs, stale:true };
  return { value:item.value, cacheAgeMs, stale:false };
}

function set(key, value) {
  store.set(key, { value, savedAt:Date.now() });
  return value;
}

module.exports = { get, set };
