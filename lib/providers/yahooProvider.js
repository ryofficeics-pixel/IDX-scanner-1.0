'use strict';

const providerCache = require('../cache/memoryCache');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, { timeoutMs = 9000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; IDXScanner/2.1; +https://vercel.app)',
          Accept: 'application/json,text/plain,*/*',
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(250 * Math.pow(2, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function yahooSymbol(symbol) {
  return symbol === '^JKSE' ? '^JKSE' : `${String(symbol).replace('.JK', '')}.JK`;
}

function normalizeQuote(symbol, q, source) {
  const lastPrice = num(q.regularMarketPrice ?? q.price);
  const previousClose = num(q.regularMarketPreviousClose ?? q.previousClose ?? q.chartPreviousClose);
  return {
    symbol,
    yahooSymbol: yahooSymbol(symbol),
    name: q.shortName || q.longName || symbol,
    lastPrice,
    previousClose,
    dayHigh: num(q.regularMarketDayHigh ?? q.dayHigh) ?? lastPrice,
    dayLow: num(q.regularMarketDayLow ?? q.dayLow) ?? lastPrice,
    volume: num(q.regularMarketVolume ?? q.volume),
    avgVolume20: num(q.averageDailyVolume3Month ?? q.averageDailyVolume10Day),
    changePct: num(q.regularMarketChangePercent),
    timestamp: new Date().toISOString(),
    marketState: q.marketState || null,
    source,
  };
}
function normalizeChartQuote(symbol, meta, source) {
  const lastPrice = num(meta.regularMarketPrice);
  const previousClose = num(meta.chartPreviousClose ?? meta.previousClose);
  return {
    symbol,
    yahooSymbol: yahooSymbol(symbol),
    name: meta.shortName || symbol,
    lastPrice,
    previousClose,
    dayHigh: num(meta.regularMarketDayHigh) ?? lastPrice,
    dayLow: num(meta.regularMarketDayLow) ?? lastPrice,
    volume: num(meta.regularMarketVolume),
    avgVolume20:null,
    changePct: previousClose > 0 && lastPrice > 0 ? ((lastPrice - previousClose) / previousClose) * 100 : null,
    timestamp: new Date().toISOString(),
    marketState: meta.marketState || null,
    source,
  };
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

async function getQuote(symbol) {
  const batch = await getBatchQuotes([symbol]);
  return batch.quotes[symbol] || null;
}

async function getBatchQuotes(symbols, options = {}) {
  const clean = [...new Set(symbols)].filter(Boolean);
  const cacheKey = `quotes:${clean.join(',')}`;
  const cached = providerCache.get(cacheKey, 25000);
  if (!options.bypassCache && cached && !cached.stale) {
    return { ...cached.value, cacheHit:true, cacheAgeMs:cached.cacheAgeMs };
  }

  const quotes = {};
  const failedSymbols = [];
  const warnings = [];
  let quoteStatus = 'not_attempted';
  let chartStatus = 'not_attempted';
  if (options.delayMs) await sleep(Math.max(0, Math.min(Number(options.delayMs) || 0, 10000)));
  const batches = [];
  for (let i = 0; i < clean.length; i += 40) batches.push(clean.slice(i, i + 40));
  for (const batch of batches) {
    const yf = ['^JKSE', ...batch.map(yahooSymbol)].join(',');
    try {
      if (options.forceQuoteFail) throw new Error('FORCED_QUOTE_FAIL');
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yf)}`;
      const json = await fetchJson(url, { timeoutMs:10000, retries:2 });
      const list = json?.quoteResponse?.result || [];
      for (const q of list) {
        const symbol = q.symbol === '^JKSE' ? '^JKSE' : String(q.symbol || '').replace('.JK', '');
        quotes[symbol] = normalizeQuote(symbol, q, 'yahoo-finance-v7');
      }
      quoteStatus = 'ok';
    } catch (error) {
      quoteStatus = 'error';
      warnings.push(`Yahoo batch failed: ${error.message}`);
    }
  }
  const missing = clean.filter((symbol) => !quotes[symbol]).slice(0, 150);
  if (!quotes['^JKSE']) missing.unshift('^JKSE');
  await mapLimit([...new Set(missing)], 6, async (symbol) => {
    try {
      if (options.forceChartFail) throw new Error('FORCED_CHART_FAIL');
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?interval=1d&range=1d`;
      const json = await fetchJson(url, { timeoutMs:8000, retries:1 });
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || num(meta.regularMarketPrice) == null) throw new Error('NO_PRICE');
      quotes[symbol] = normalizeChartQuote(symbol, meta, 'yahoo-finance-v8');
      chartStatus = 'ok';
    } catch (error) {
      chartStatus = 'error';
      if (symbol !== '^JKSE') failedSymbols.push(symbol);
    }
  });
  for (const symbol of clean) {
    if (!quotes[symbol]) failedSymbols.push(symbol);
  }
  const result = {
    quotes,
    ihsg:quotes['^JKSE'] || null,
    failedSymbols:[...new Set(failedSymbols)],
    warnings,
    provider:'yahoo-finance',
    providerPrimaryStatus:quoteStatus,
    providerFallbackStatus:chartStatus,
  };
  providerCache.set(cacheKey, result);
  return result;
}

async function getDailyHistory(symbol, range = '1mo', interval = '1d') {
  return chartHistory(symbol, range, interval);
}

async function getIntradayHistory(symbol, range = '1d', interval = '5m') {
  return chartHistory(symbol, range, interval);
}

async function chartHistory(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  const json = await fetchJson(url, { timeoutMs:9000, retries:1 });
  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    timestamp:new Date(t * 1000).toISOString(),
    open:num(q.open?.[i]),
    high:num(q.high?.[i]),
    low:num(q.low?.[i]),
    close:num(q.close?.[i]),
    volume:num(q.volume?.[i]),
  })).filter((row) => row.close != null);
}

module.exports = { getQuote, getBatchQuotes, getDailyHistory, getIntradayHistory };
