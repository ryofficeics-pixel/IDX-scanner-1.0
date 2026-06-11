'use strict';

const cache = require('../lib/cache/memoryCache');
const { getUniverse } = require('../lib/market/idxUniverse');
const { sessionContext } = require('../lib/market/idxSession');
const yahoo = require('../lib/providers/yahooProvider');
const fallback = require('../lib/providers/fallbackProvider');
const { generateSignal } = require('../lib/engine/signalEngine');

function send(res, status, body) {
  res.status(status).json(body);
}
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}
function emptyRecs() {
  return { strongBuy:[], beliPagi:[], beliSore:[], topBuy:[], topGainers:[], accumulationProxy:[], distributionProxy:[], risk:[], hold:[], sell:[] };
}
function pushRec(recs, sig) {
  if (sig.action === 'STRONG_BUY') recs.strongBuy.push(sig);
  if (sig.category === 'BELI_PAGI') recs.beliPagi.push(sig);
  if (sig.category === 'BELI_SORE') recs.beliSore.push(sig);
  if (sig.action === 'BUY' || sig.category === 'TOP_BUY') recs.topBuy.push(sig);
  if (sig.changePct > 0) recs.topGainers.push(sig);
  if (sig.category === 'ACCUMULATION_PROXY') recs.accumulationProxy.push(sig);
  if (sig.category === 'DISTRIBUTION_PROXY') recs.distributionProxy.push(sig);
  if (sig.riskLevel === 'HIGH' || sig.category === 'RISK') recs.risk.push(sig);
  if (sig.action === 'HOLD' || sig.action === 'WATCH') recs.hold.push(sig);
  if (sig.action === 'SELL' || sig.action === 'AVOID') recs.sell.push(sig);
}
function avgDailyVolume(candles) {
  const volumes = (candles || [])
    .map((c) => Number(c.volume))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(-20);
  if (!volumes.length) return null;
  return volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
}
async function mapLimit(items, limit, worker) {
  const out = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length:Math.min(limit, items.length) }, run));
  return out;
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { ok:false, error:'METHOD_NOT_ALLOWED' });

  const limit = Math.max(1, Math.min(Number(req.query?.limit) || 120, 180));
  const debug = req.query?.debug === '1';
  const universe = getUniverse({ symbols:req.query?.symbols, limit });
  const symbols = universe.map((row) => row.symbol);
  const cacheKey = `scan:${symbols.join(',')}:${debug ? 'debug' : 'normal'}`;
  const cached = cache.get(cacheKey, 60 * 1000);
  if (cached && !cached.stale) {
    const payload = JSON.parse(JSON.stringify(cached.value));
    payload.diagnostics.cacheHit = true;
    payload.diagnostics.cacheAgeMs = cached.cacheAgeMs;
    return send(res, 200, payload);
  }

  const generatedAt = new Date().toISOString();
  const session = sessionContext();
  const diagnostics = { provider:'yahoo-finance', cacheHit:false, cacheAgeMs:0, failedSymbols:[], warnings:[], errors:[] };
  let provider;
  try {
    provider = await yahoo.getBatchQuotes(symbols);
  } catch (error) {
    diagnostics.errors.push(`Primary provider failed: ${error.message}`);
    provider = fallback.structuredFailure(symbols, error.message);
  }
  diagnostics.failedSymbols = provider.failedSymbols || [];
  diagnostics.warnings = provider.warnings || [];
  const ihsg = provider.ihsg || provider.quotes?.['^JKSE'] || null;
  const market = {
    ihsgPrice: ihsg?.lastPrice ?? null,
    ihsgChangePct: ihsg?.previousClose > 0 && ihsg?.lastPrice > 0 ? ((ihsg.lastPrice - ihsg.previousClose) / ihsg.previousClose) * 100 : ihsg?.changePct ?? null,
    source: ihsg?.source || 'yahoo-finance',
    timestamp: ihsg?.timestamp || generatedAt,
  };

  const recs = emptyRecs();
  const signals = [];
  const meta = new Map(universe.map((row) => [row.symbol, row]));
  const candidates = Object.values(provider.quotes || {})
    .filter((q) => q.symbol !== '^JKSE' && q.lastPrice != null)
    .sort((a, b) => ((b.volume || 0) * (b.lastPrice || 0)) - ((a.volume || 0) * (a.lastPrice || 0)))
    .slice(0, debug ? symbols.length : 35);
  const historyBySymbol = {};
  await mapLimit(candidates, 5, async (q) => {
    const [daily, intraday] = await Promise.allSettled([
      yahoo.getDailyHistory(q.symbol, '1mo', '1d'),
      yahoo.getIntradayHistory(q.symbol, '1d', '5m'),
    ]);
    historyBySymbol[q.symbol] = {
      daily:daily.status === 'fulfilled' ? daily.value : [],
      intraday:intraday.status === 'fulfilled' ? intraday.value : [],
    };
    const derivedAvgVolume = avgDailyVolume(historyBySymbol[q.symbol].daily);
    if (derivedAvgVolume && !q.avgVolume20) q.avgVolume20 = derivedAvgVolume;
  });

  for (const symbol of symbols) {
    const q = provider.quotes?.[symbol] || { symbol, yahooSymbol:`${symbol}.JK`, lastPrice:null, previousClose:null, timestamp:generatedAt, source:'none' };
    const row = meta.get(symbol) || {};
    const sig = generateSignal({ ...q, name:q.name || row.name || symbol }, market, session, historyBySymbol[symbol] || {});
    signals.push(sig);
    pushRec(recs, sig);
  }
  Object.keys(recs).forEach((key) => {
    recs[key].sort((a, b) => (b.score - a.score) || ((b.changePct || 0) - (a.changePct || 0)));
    if (!debug) recs[key] = recs[key].slice(0, key === 'hold' ? 40 : 20);
  });
  const valid = signals.filter((s) => s.dataQuality >= 40).length;
  const noData = signals.filter((s) => s.action === 'NO_DATA').length;
  const errorCount = diagnostics.failedSymbols.length + diagnostics.errors.length;
  const payload = {
    ok:true,
    generatedAt,
    timezone:'Asia/Jakarta',
    session:{ status:session.status, sessionProgress:session.sessionProgress, expectedVolumeProgress:session.expectedVolumeProgress },
    market,
    summary:{
      scanned:symbols.length,
      valid,
      noData,
      strongBuyCount:recs.strongBuy.length,
      buyCount:signals.filter((s) => s.action === 'BUY' || s.action === 'STRONG_BUY').length,
      holdCount:signals.filter((s) => s.action === 'HOLD' || s.action === 'WATCH').length,
      sellCount:signals.filter((s) => s.action === 'SELL' || s.action === 'AVOID').length,
      topGainerCount:recs.topGainers.length,
      accumulationProxyCount:recs.accumulationProxy.length,
      distributionProxyCount:recs.distributionProxy.length,
      errorCount,
    },
    recommendations:recs,
    diagnostics,
  };
  cache.set(cacheKey, payload);
  return send(res, 200, payload);
};
