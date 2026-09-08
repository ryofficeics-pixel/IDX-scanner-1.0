'use strict';

const redis = require('../cache/redisCache');
const { dayKey } = require('../market/historyContext');
const TTL_SECONDS = 3 * 24 * 3600;
const memory = new Map();

async function read(symbols, now = new Date()) {
  const oldest = new Date(new Date(now).getTime() - TTL_SECONDS * 1000).toISOString();
  const fresh = (state) => state && state.updatedAt >= oldest && state.updatedAt <= new Date(now).toISOString();
  const local = symbols.map((symbol) => memory.get(symbol)).filter(fresh);
  const missing = symbols.filter((symbol) => !fresh(memory.get(symbol)));
  const remote = await redis.getMany(missing.map((symbol) => `setup:${symbol}`), TTL_SECONDS * 1000);
  for (const state of remote.filter(fresh)) memory.set(state.symbol, state);
  return [...local, ...remote.filter(fresh)];
}

async function save(signals, now = new Date()) {
  const states = signals.filter((signal) => signal.indicators?.setupHistoryAvailable && signal.dataQuality >= 60).map((signal) => ({
    symbol:signal.symbol, date:dayKey(now), updatedAt:new Date(now).toISOString(), setupScore:signal.indicators.setupScore,
    signalPhase:signal.signalPhase, close:signal.lastPrice, distanceToBreakout:signal.indicators.distanceTo20dHighPct,
    compressionScore:signal.indicators.volatilityCompressionScore, flowScore:signal.indicators.flowScore,
    relativeStrengthScore:signal.indicators.relativeStrengthScore,
  }));
  for (const state of states) memory.set(state.symbol, state);
  for (const [symbol, state] of memory) if (new Date(now) - new Date(state.updatedAt) > TTL_SECONDS * 1000) memory.delete(symbol);
  await redis.setMany(states.map((state) => [`setup:${state.symbol}`, state]), TTL_SECONDS);
}

module.exports = { read, save };
