'use strict';

const cache = require('../lib/cache/memoryCache');
const { getUniverse } = require('../lib/market/idxUniverse');
const { sessionContext } = require('../lib/market/idxSession');
const yahoo = require('../lib/providers/yahooProvider');
const idx = require('../lib/providers/idxProvider');
const fallback = require('../lib/providers/fallbackProvider');
const { generateSignal } = require('../lib/engine/signalEngine');
const { generateBowSignal } = require('../lib/engine/bowEngine');
const { updateScanState } = require('../lib/runtime/scanState');

function send(res, status, body) {
  res.status(status).json(body);
}
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}
function emptyRecs() {
  return { strongBuy:[], beliPagi:[], beliSore:[], buyOnWeakness:[], topBuy:[], topGainers:[], accumulationProxy:[], distributionProxy:[], risk:[], hold:[], sell:[] };
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
function pushBowRec(recs, bow) {
  if (!bow) return;
  if (bow.action === 'BOW_BUY' || bow.score >= 70) recs.buyOnWeakness.push(bow);
  else if (bow.category === 'Falling Knife' || bow.volume === 'Distribution') recs.risk.push({
    ...bow,
    action:'AVOID',
    category:'RISK',
    riskLevel:'HIGH',
    dataQuality:70,
    confidence:bow.score,
  });
}
function avgDailyVolume(candles) {
  const volumes = (candles || [])
    .map((c) => Number(c.volume))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(-20);
  if (!volumes.length) return null;
  return volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
}
function latestTimestamp(items, fallback) {
  const times = (items || [])
    .map((item) => item?.timestamp ? new Date(item.timestamp).getTime() : NaN)
    .filter((time) => Number.isFinite(time));
  if (!times.length) return fallback;
  return new Date(Math.max(...times)).toISOString();
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
async function withTimeout(label, ms, task) {
  // Bound provider calls so one slow upstream cannot stall the whole scan request.
  return Promise.race([
    task(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms)),
  ]);
}

async function getMarketQuote({ debug, forceQuoteFail }) {
  // Prefer IDX for IHSG only; stock quotes remain on Yahoo and fallback preserves the old market fields.
  try {
    return await withTimeout('IDX_IHSG', 6000, () => idx.getIHSGQuote({ bypassCache:debug, timeoutMs:5000 }));
  } catch (idxError) {
    const fallbackBatch = await withTimeout('YAHOO_IHSG', 9000, () => yahoo.getBatchQuotes(['^JKSE'], { forceQuoteFail, bypassCache:debug }));
    const quote = fallbackBatch.quotes?.['^JKSE'] || fallbackBatch.ihsg || null;
    if (quote) return { ...quote, source:quote.source || 'yahoo-finance' };
    throw idxError;
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { ok:false, error:'METHOD_NOT_ALLOWED' });

  const scanStartedAt = new Date().toISOString();
  const providerStart = Date.now();
  const limit = Math.max(1, Math.min(Number(req.query?.limit) || 120, 1000));
  const offset = Math.max(0, Number(req.query?.offset) || 0);
  const debug = req.query?.debug === '1';
  const mockTime = debug && req.query?.mockTime ? new Date(String(req.query.mockTime)) : null;
  const now = mockTime && Number.isFinite(mockTime.getTime()) ? mockTime : new Date();
  const forceProviderFail = debug && req.query?.forceProviderFail === '1';
  const forceQuoteFail = debug && req.query?.forceQuoteFail === '1';
  const forceChartFail = debug && req.query?.forceChartFail === '1';
  const corruptOneSymbol = debug && req.query?.corruptOneSymbol === '1';
  const mockProviderDelayMs = debug ? Math.max(0, Math.min(Number(req.query?.mockProviderDelayMs) || 0, 10000)) : 0;
  const universe = getUniverse({ symbols:req.query?.symbols, limit, offset });
  const symbols = universe.map((row) => row.symbol);
  const cacheKey = `scan:${symbols.join(',')}:${debug ? JSON.stringify(req.query) : 'normal'}`;
  const cached = cache.get(cacheKey, 60 * 1000);
  if (cached && !cached.stale) {
    const payload = JSON.parse(JSON.stringify(cached.value));
    payload.diagnostics.cacheHit = true;
    payload.diagnostics.cacheAgeMs = cached.cacheAgeMs;
    payload.diagnostics.dataFreshness = cached.cacheAgeMs > 15 * 60 * 1000 ? 'stale' : 'cache';
    updateScanState({
      lastCacheStatus:'hit',
      lastSuccessfulScanAt:payload.generatedAt,
      lastScanValidCount:payload.summary?.valid || 0,
      lastScanFailedCount:payload.diagnostics?.failedSymbols?.length || 0,
      lastProviderStatus:payload.diagnostics?.providerFallbackStatus || payload.diagnostics?.providerPrimaryStatus || 'cache',
    });
    return send(res, 200, payload);
  }

  const generatedAt = now.toISOString();
  const marketDate = now.toLocaleDateString('en-CA', { timeZone:'Asia/Jakarta' });
  const session = sessionContext(now);
  const diagnostics = {
    provider:'yahoo-finance',
    providerPrimaryStatus:'not_attempted',
    providerFallbackStatus:'not_attempted',
    providerLatencyMs:0,
    cacheHit:false,
    cacheAgeMs:0,
    scanStartedAt,
    scanFinishedAt:null,
    dataFreshness:'live',
    failedSymbols:[],
    validRatio:0,
    noDataRatio:0,
    warnings:[],
    errors:[],
  };
  let provider;
  try {
    if (forceProviderFail) throw new Error('FORCED_PROVIDER_FAIL');
    provider = await withTimeout('YAHOO_BATCH_QUOTES', 30000, () => yahoo.getBatchQuotes(symbols, {
      forceQuoteFail,
      forceChartFail,
      delayMs:mockProviderDelayMs,
      bypassCache:debug,
    }));
  } catch (error) {
    diagnostics.errors.push(`Primary provider failed: ${error.message}`);
    provider = fallback.structuredFailure(symbols, error.message);
    provider.providerPrimaryStatus = 'error';
    provider.providerFallbackStatus = 'error';
  }
  diagnostics.providerLatencyMs = Date.now() - providerStart;
  diagnostics.providerPrimaryStatus = provider.providerPrimaryStatus || 'unknown';
  diagnostics.providerFallbackStatus = provider.providerFallbackStatus || 'unknown';
  diagnostics.failedSymbols = provider.failedSymbols || [];
  diagnostics.warnings = provider.warnings || [];
  let ihsg = null;
  try {
    ihsg = await getMarketQuote({ debug, forceQuoteFail });
  } catch (error) {
    diagnostics.warnings.push(`IHSG provider failed: ${error.message}`);
  }
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
    // Request history only for the top 20 liquid symbols; lower-ranked symbols keep quote-only recommendations.
    .slice(0, Math.min(symbols.length, 20));
  const historyBySymbol = {};
  let ihsgDaily = [];
  try {
    ihsgDaily = await withTimeout('YAHOO_IHSG_DAILY', 10000, () => yahoo.getDailyHistory('^JKSE', '3mo', '1d'));
  } catch (_) {
    ihsgDaily = [];
  }
  const ihsgCloses = ihsgDaily.map((c) => Number(c.close)).filter(Number.isFinite);
  const ihsgReturn3M = ihsgCloses.length > 63 && ihsgCloses[0] > 0
    ? ((ihsgCloses[ihsgCloses.length - 1] - ihsgCloses[0]) / ihsgCloses[0]) * 100
    : null;
  const historyFailures = new Set();
  await mapLimit(candidates, 10, async (q) => {
    const [daily, intraday] = await Promise.allSettled([
      withTimeout(`DAILY_${q.symbol}`, 12000, () => yahoo.getDailyHistory(q.symbol, '1y', '1d')),
      withTimeout(`INTRADAY_${q.symbol}`, 8000, () => yahoo.getIntradayHistory(q.symbol, '1d', '5m')),
    ]);
    // Preserve partial result mode: history failures mark diagnostics but never abort the scan.
    if (daily.status !== 'fulfilled' || intraday.status !== 'fulfilled') historyFailures.add(q.symbol);
    historyBySymbol[q.symbol] = {
      daily:daily.status === 'fulfilled' ? daily.value : [],
      intraday:intraday.status === 'fulfilled' ? intraday.value : [],
    };
    const derivedAvgVolume = avgDailyVolume(historyBySymbol[q.symbol].daily);
    if (derivedAvgVolume && !q.avgVolume20) q.avgVolume20 = derivedAvgVolume;
  });
  if (historyFailures.size) {
    diagnostics.failedSymbols = [...new Set([...(diagnostics.failedSymbols || []), ...historyFailures])];
    diagnostics.warnings.push(`Partial history unavailable for ${historyFailures.size} symbol(s)`);
  }

  for (const symbol of symbols) {
    const q = provider.quotes?.[symbol] || { symbol, yahooSymbol:`${symbol}.JK`, lastPrice:null, previousClose:null, timestamp:generatedAt, source:'none' };
    if (corruptOneSymbol && symbol === symbols[0]) {
      q.lastPrice = -1;
      q.previousClose = 0;
      q.dayHigh = 1;
      q.dayLow = 2;
    }
    const row = meta.get(symbol) || {};
    const stock = { ...q, name:q.name || row.name || symbol };
    const histories = { ...(historyBySymbol[symbol] || {}), now };
    const sig = generateSignal(stock, market, session, histories);
    signals.push(sig);
    pushRec(recs, sig);
    if (histories.daily && histories.daily.length) {
      const bow = generateBowSignal(stock, { ...market, ihsgReturn3M }, histories);
      sig.buyOnWeakness = bow;
      pushBowRec(recs, bow);
    }
  }
  Object.keys(recs).forEach((key) => {
    recs[key].sort((a, b) => (b.score - a.score) || ((b.changePct || 0) - (a.changePct || 0)));
    if (!debug) recs[key] = recs[key].slice(0, key === 'hold' ? 40 : 20);
  });
  const valid = signals.filter((s) => s.dataQuality >= 40).length;
  const noData = signals.filter((s) => s.action === 'NO_DATA').length;
  const errorCount = diagnostics.failedSymbols.length + diagnostics.errors.length;
  diagnostics.validRatio = symbols.length ? valid / symbols.length : 0;
  diagnostics.noDataRatio = symbols.length ? noData / symbols.length : 0;
  diagnostics.scanFinishedAt = new Date().toISOString();
  diagnostics.providerDataTimestamp = latestTimestamp(Object.values(provider.quotes || {}), generatedAt);
  if (!valid) diagnostics.dataFreshness = 'no-data';
  const payload = {
    ok:true,
    generatedAt,
    lastUpdated:diagnostics.providerDataTimestamp,
    marketDate,
    timezone:'Asia/Jakarta',
    session:{ status:session.status, sessionProgress:session.sessionProgress, expectedVolumeProgress:session.expectedVolumeProgress },
    market,
    summary:{
      scanned:symbols.length,
      valid,
      noData,
      strongBuyCount:recs.strongBuy.length,
      buyOnWeaknessCount:recs.buyOnWeakness.length,
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
  updateScanState({
    lastCacheStatus:'miss',
    lastSuccessfulScanAt:valid ? generatedAt : null,
    lastScanValidCount:valid,
    lastScanFailedCount:diagnostics.failedSymbols.length,
    lastProviderStatus:`primary:${diagnostics.providerPrimaryStatus},fallback:${diagnostics.providerFallbackStatus}`,
  });
  return send(res, 200, payload);
};
