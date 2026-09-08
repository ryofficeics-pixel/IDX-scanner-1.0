'use strict';

const { Redis } = require('@upstash/redis');
const { dayKey, number } = require('../market/historyContext');

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
    client = new Redis({ url: REDIS_URL, token: REDIS_TOKEN, retry:false, signal:() => AbortSignal.timeout(1500) });
    return client;
  } catch {
    return null;
  }
}

async function record(symbol, netBuy, foreignBuy, foreignSell, tradeDate) {
  if (number(netBuy) == null || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate || '') || tradeDate > dayKey(new Date())) return;
  if (!Number.isFinite(Date.parse(tradeDate)) || dayKey(tradeDate) !== tradeDate) return;
  const r = getClient();
  if (!r) return;
  const key = PREFIX + symbol.toUpperCase();
  const today = tradeDate;
  const entry = { date: today, netBuy:Number(netBuy), foreignBuy:number(foreignBuy), foreignSell:number(foreignSell) };

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

async function getCumulative3d(symbol, now = new Date()) {
  const r = getClient();
  if (!r) return null;
  const key = PREFIX + symbol.toUpperCase();

  try {
    const raw = await r.get(key);
    if (!raw) return null;
    const entries = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const cutoff = dayKey(now);
    const oldest = dayKey(new Date(new Date(now).getTime() - 10 * 86400000));
    const sorted = entries.filter((entry) => entry.date <= cutoff && entry.date >= oldest && number(entry.netBuy) != null).sort((a, b) => b.date.localeCompare(a.date));
    if (!sorted.length) return null;
    const last3 = sorted.slice(0, 3);
    const sum = last3.reduce((acc, e) => acc + number(e.netBuy, 0), 0);
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
