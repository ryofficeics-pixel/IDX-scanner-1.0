'use strict';

const { Redis } = require('@upstash/redis');

const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.REDIS_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PREFIX = 'idxscan:fnd:';
const MAX_ENTRIES = 90;
const STORE_TTL = 90 * 24 * 3600;

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

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function record(symbol, netBuy, foreignBuy, foreignSell) {
  if (netBuy == null) return;
  const r = getClient();
  if (!r) return;
  const key = PREFIX + symbol.toUpperCase();
  const today = todayStr();
  const entry = { date: today, netBuy, foreignBuy, foreignSell };

  try {
    const raw = await r.get(key);
    let entries = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    if (!Array.isArray(entries)) entries = [];
    const existingIdx = entries.findIndex((e) => e.date === today);
    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    await r.set(key, JSON.stringify(entries), { ex: STORE_TTL });
  } catch {}
}

async function getCumulative3d(symbol) {
  const r = getClient();
  if (!r) return null;
  const key = PREFIX + symbol.toUpperCase();

  try {
    const raw = await r.get(key);
    if (!raw) return null;
    const entries = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
    const last3 = sorted.slice(0, 3);
    const sum = last3.reduce((acc, e) => acc + (e.netBuy || 0), 0);
    return {
      cumulative: sum,
      days: last3.map((e) => ({ date: e.date, netBuy: e.netBuy })),
      count: last3.filter((e) => e.netBuy != null).length,
    };
  } catch {
    return null;
  }
}

async function getHistory(symbol, days = 10) {
  const r = getClient();
  if (!r) return [];
  const key = PREFIX + symbol.toUpperCase();

  try {
    const raw = await r.get(key);
    if (!raw) return [];
    const entries = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(entries)) return [];
    const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
    return sorted.slice(0, days);
  } catch {
    return [];
  }
}

module.exports = { record, getCumulative3d, getHistory, isAvailable: () => getClient() !== null };
