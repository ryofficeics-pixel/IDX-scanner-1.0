'use strict';

const providerCache = require('../cache/memoryCache');

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      // IDX public endpoints can reject generic fetch clients; keep browser-like headers and still fail fast.
      headers:{
        'User-Agent':'Mozilla/5.0 (compatible; IDXScanner/2.1; +https://vercel.app)',
        Accept:'application/json,text/plain,*/*',
        Referer:'https://www.idx.co.id/en/market-data/trading-summary/stock-summary',
      },
      signal:controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// IHSG index quote
// ---------------------------------------------------------------------------

function normalizeIndexRow(row) {
  const code = String(row?.IndexCode || row?.Index || row?.Code || row?.indexCode || '').toUpperCase();
  if (code && !['COMPOSITE', 'IHSG', 'IDX COMPOSITE'].includes(code)) return null;
  const lastPrice = num(row?.LastVal ?? row?.Last ?? row?.Close ?? row?.lastVal);
  const previousClose = num(row?.PrevVal ?? row?.Previous ?? row?.Prev ?? row?.previous);
  const changePct = num(row?.ChgPct ?? row?.ChangePct ?? row?.ChangePercent ?? row?.chgPct);
  if (lastPrice == null) return null;
  return {
    symbol:'^JKSE',
    yahooSymbol:'^JKSE',
    name:'IDX Composite',
    lastPrice,
    previousClose,
    dayHigh:num(row?.HighVal ?? row?.High ?? row?.highVal) ?? lastPrice,
    dayLow:num(row?.LowVal ?? row?.Low ?? row?.lowVal) ?? lastPrice,
    volume:null,
    avgVolume20:null,
    changePct,
    timestamp:new Date().toISOString(),
    marketState:null,
    source:'idx-public',
  };
}

async function getIHSGQuote(options = {}) {
  const cacheKey = 'idx:ihsg';
  const cached = providerCache.get(cacheKey, 60 * 1000);
  if (!options.bypassCache && cached && !cached.stale) return { ...cached.value, cacheHit:true, cacheAgeMs:cached.cacheAgeMs };

  // Official IDX public surface endpoint; if Cloudflare or schema drift blocks it, scan.js falls back to Yahoo.
  const json = await fetchJson('https://www.idx.co.id/umbraco/Surface/TradingSummary/GetIndexSummary?start=0&length=120', options.timeoutMs || 5000);
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.Items) ? json.Items : Array.isArray(json) ? json : [];
  const quote = rows.map(normalizeIndexRow).find(Boolean);
  if (!quote) throw new Error('IDX_IHSG_NOT_FOUND');
  providerCache.set(cacheKey, quote);
  return quote;
}

// ---------------------------------------------------------------------------
// Per-stock trading summary (broker/foreign/freq flow) from IDX surface API.
//
// Source: https://www.idx.co.id/umbraco/Surface/TradingSummary/GetStockSummary
// Field mapping derived from NeaByteLab/IDX-API (MIT license) and direct
// inspection of the IDX public surface response schema.
//
// Returns a Map<symbol, flowData> keyed by uppercase IDX ticker (no .JK suffix).
// Fields that feed the signal engine:
//   brokerBuy, brokerSell  — aggregate broker buy/sell value (IDR)
//   foreignBuy, foreignSell — foreign net buy/sell value (IDR)
//   netBuy                 — net buy value (foreignBuy - foreignSell)
//   freqBuy, freqSell      — transaction frequency buy/sell (proxy from Frequency field)
//   volumeAvg5d            — not available from this endpoint; left null
//   volume, value          — today's volume/value for cross-check
// ---------------------------------------------------------------------------

function normalizeStockRow(row) {
  // IDX surface returns camelCase or PascalCase depending on endpoint version.
  const symbol = String(
    row?.StockCode ?? row?.stockCode ?? row?.Code ?? row?.code ?? ''
  ).trim().toUpperCase().replace(/\.JK$/i, '');
  if (!symbol) return null;

  const close   = num(row?.Close   ?? row?.close   ?? row?.LastPrice ?? row?.lastPrice);
  const prev    = num(row?.Previous ?? row?.previous ?? row?.PrevClose ?? row?.prevClose);
  const open    = num(row?.OpenPrice ?? row?.openPrice ?? row?.Open ?? row?.open);
  const high    = num(row?.High    ?? row?.high);
  const low     = num(row?.Low     ?? row?.low);
  const volume  = num(row?.Volume  ?? row?.volume);
  const value   = num(row?.Value   ?? row?.value);
  const freq    = num(row?.Frequency ?? row?.frequency);

  // Foreign flow — IDX surface exposes ForeignBuy / ForeignSell in some
  // endpoint variants; fall back to null if not present.
  const foreignBuy  = num(row?.ForeignBuy  ?? row?.foreignBuy  ?? row?.Foreign_Buy  ?? null);
  const foreignSell = num(row?.ForeignSell ?? row?.foreignSell ?? row?.Foreign_Sell ?? null);
  const netBuy      = (foreignBuy != null && foreignSell != null)
    ? foreignBuy - foreignSell
    : num(row?.NetBuy ?? row?.netBuy ?? null);

  // Broker buy/sell — available in GetStockSummary as Bid/Offer proxy or
  // direct fields on some versions.
  const brokerBuy  = num(row?.Bid       ?? row?.bid       ?? row?.BrokerBuy  ?? row?.brokerBuy  ?? null);
  const brokerSell = num(row?.Offer     ?? row?.offer     ?? row?.BrokerSell ?? row?.brokerSell ?? null);

  // Frequency split — IDX doesn't expose buy/sell freq separately in this
  // endpoint; use total freq as a neutral signal (engine handles null splits).
  const freqBuy  = num(row?.FreqBuy  ?? row?.freqBuy  ?? null);
  const freqSell = num(row?.FreqSell ?? row?.freqSell ?? null);

  return {
    symbol,
    close, prev, open, high, low,
    volume, value, freq,
    foreignBuy, foreignSell, netBuy,
    brokerBuy, brokerSell,
    freqBuy, freqSell,
    volumeAvg5d: null, // not available from this endpoint
    source: 'idx-stock-summary',
    tradeDate: String(row?.Date ?? row?.date ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10),
  };
}

/**
 * Fetch today's per-stock trading summary from IDX surface API.
 * Returns a Map<symbol, flowData> for all stocks returned by the endpoint.
 * Gracefully returns an empty Map on any network/schema error so callers
 * can treat it as an optional enrichment layer.
 *
 * @param {object} options
 * @param {boolean} [options.bypassCache]
 * @param {number}  [options.timeoutMs]
 * @returns {Promise<Map<string,object>>}
 */
async function getBatchStockSummary(options = {}) {
  const cacheKey = 'idx:stock-summary';
  const TTL_MS = 90 * 1000; // 90 s — coarser than quote cache, endpoint is slower
  const cached = providerCache.get(cacheKey, TTL_MS);
  if (!options.bypassCache && cached && !cached.stale) {
    return cached.value; // already a Map
  }

  const timeoutMs = options.timeoutMs || 8000;
  const result = new Map();

  try {
    const date = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Jakarta' }).replace(/-/g, '');
    const url = `https://www.idx.co.id/umbraco/Surface/TradingSummary/GetStockSummary?start=0&length=9999&date=${date}`;
    const json = await fetchJson(url, timeoutMs);
    const rows = Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.Data) ? json.Data
      : Array.isArray(json)       ? json
      : [];

    for (const row of rows) {
      const norm = normalizeStockRow(row);
      if (norm && norm.symbol) result.set(norm.symbol, norm);
    }
  } catch (err) {
    // Non-fatal: log and return empty map so callers fall back to Yahoo-only flow.
    warnings.push(`IDX stock summary fetch failed: ${err.message}`);
  }

  if (result.size > 0) {
    providerCache.set(cacheKey, result);
  }
  return result;
}

module.exports = { getIHSGQuote, getBatchStockSummary };
