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
        Referer:'https://www.idx.co.id/en/market-data/trading-summary/index-summary',
      },
      signal:controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

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

module.exports = { getIHSGQuote };
