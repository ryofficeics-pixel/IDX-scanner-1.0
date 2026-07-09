'use strict';

const providerCache = require('../cache/memoryCache');
const redisCache = require('../cache/redisCache');

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url, { timeoutMs = 8000, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; IDXScanner/2.1; +https://vercel.app)',
          Accept: 'application/json,text/plain,*/*',
          Referer: 'https://www.idx.co.id/',
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function normalizeQuote(symbol, row) {
  const lastPrice = num(row?.lastPrice ?? row?.LastPrice ?? row?.price ?? row?.Price ?? row?.close ?? row?.Close);
  const previousClose = num(row?.previousClose ?? row?.PreviousClose ?? row?.prevClose ?? row?.prevPrice ?? row?.Previous ?? row?.Prev ?? row?.previous);
  if (lastPrice == null || previousClose == null) return null;
  return {
    symbol: String(symbol).replace('.JK', ''),
    yahooSymbol: `${String(symbol).replace('.JK', '')}.JK`,
    name: String(row?.name ?? row?.Name ?? row?.stockName ?? row?.StockName ?? symbol ?? ''),
    lastPrice,
    previousClose,
    dayHigh: num(row?.dayHigh ?? row?.DayHigh ?? row?.high ?? row?.High ?? row?.max ?? row?.Max) || lastPrice,
    dayLow: num(row?.dayLow ?? row?.DayLow ?? row?.low ?? row?.Low ?? row?.min ?? row?.Min) || lastPrice,
    volume: num(row?.volume ?? row?.Volume ?? row?.vol ?? row?.Vol ?? row?.totalVolume ?? row?.TotalVolume),
    avgVolume20: num(row?.avgVolume20 ?? row?.AvgVolume20 ?? row?.volumeAvg20 ?? row?.VolumeAvg20),
    changePct: num(row?.changePct ?? row?.ChangePct ?? row?.change ?? row?.Change ?? row?.chgPct),
    timestamp: new Date().toISOString(),
    marketState: null,
    source: 'idx-api',
  };
}

async function getStockQuote(symbol, options = {}) {
  const clean = String(symbol).replace('.JK', '').toUpperCase();
  const cacheKey = `idx-api:quote:${clean}`;
  const cached = providerCache.get(cacheKey, 30 * 1000);
  if (!options.bypassCache && cached && !cached.stale) return { ...cached.value, cacheHit: true, cacheAgeMs: cached.cacheAgeMs };

  const redisData = await redisCache.get(cacheKey, 30 * 1000);
  if (redisData && !redisData.stale) return { ...redisData.value, cacheHit: true, cacheAgeMs: redisData.cacheAgeMs, source: 'idx-api(redis)' };

  const json = await fetchJson(`https://www.idx.co.id/umbraco/Surface/TradingSummary/GetStockSummary?start=0&length=9999`, { timeoutMs: options.timeoutMs || 8000 });
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const row = rows.find((r) => {
    const code = String(r?.StockCode ?? r?.stockCode ?? r?.Code ?? r?.code ?? '').toUpperCase();
    return code === clean;
  });
  if (!row) return null;
  const quote = normalizeQuote(clean, row);
  if (!quote) return null;
  providerCache.set(cacheKey, quote);
  redisCache.set(cacheKey, quote);
  return quote;
}

async function getBatchQuotes(symbols, options = {}) {
  const start = Date.now();
  const results = { quotes: {}, failedSymbols: [], warnings: [], providerPrimaryStatus: 'ok', providerFallbackStatus: 'not_attempted' };

  try {
    const json = await fetchJson('https://www.idx.co.id/umbraco/Surface/TradingSummary/GetStockSummary?start=0&length=9999', { timeoutMs: options.timeoutMs || 10000, retries: 1 });
    const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];

    for (const symbol of symbols) {
      const clean = String(symbol).replace('.JK', '').toUpperCase();
      const row = rows.find((r) => {
        const code = String(r?.StockCode ?? r?.stockCode ?? r?.Code ?? r?.code ?? '').toUpperCase();
        return code === clean;
      });
      if (row) {
        const quote = normalizeQuote(clean, row);
        if (quote) {
          results.quotes[symbol] = { ...quote, cacheHit: false, cacheAgeMs: 0 };
          const cacheKey = `idx-api:quote:${clean}`;
          providerCache.set(cacheKey, quote);
          redisCache.set(cacheKey, quote);
          continue;
        }
      }
      results.failedSymbols.push(symbol);
    }
  } catch (err) {
    results.providerPrimaryStatus = 'error';
    results.warnings.push(`IDX API batch failed: ${err.message}`);
    results.failedSymbols = [...symbols];
  }

  results.providerLatencyMs = Date.now() - start;
  return results;
}

async function getDailyHistory(symbol, range, interval) {
  try {
    const json = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${String(symbol).replace('.JK', '')}.JK?range=${range || '1y'}&interval=${interval || '1d'}`, { timeoutMs: 10000, retries: 1 });
    const result = json?.chart?.result?.[0];
    if (!result) return [];
    const timestamps = result.timestamp || [];
    const ohlc = result.indicators?.quote?.[0] || {};
    const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];
    return timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: ohlc.open?.[i],
      high: ohlc.high?.[i],
      low: ohlc.low?.[i],
      close: ohlc.close?.[i],
      volume: ohlc.volume?.[i],
      adjclose: adjclose[i] || ohlc.close?.[i],
    })).filter((c) => c.close != null);
  } catch {
    return [];
  }
}

async function getIntradayHistory(symbol, range, interval) {
  try {
    const json = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${String(symbol).replace('.JK', '')}.JK?range=${range || '1d'}&interval=${interval || '5m'}`, { timeoutMs: 8000, retries: 1 });
    const result = json?.chart?.result?.[0];
    if (!result) return [];
    const timestamps = result.timestamp || [];
    const ohlc = result.indicators?.quote?.[0] || {};
    return timestamps.map((t, i) => ({
      timestamp: new Date(t * 1000).toISOString(),
      open: ohlc.open?.[i],
      high: ohlc.high?.[i],
      low: ohlc.low?.[i],
      close: ohlc.close?.[i],
      volume: ohlc.volume?.[i],
    })).filter((c) => c.close != null);
  } catch {
    return [];
  }
}

module.exports = { getStockQuote, getBatchQuotes, getDailyHistory, getIntradayHistory };
