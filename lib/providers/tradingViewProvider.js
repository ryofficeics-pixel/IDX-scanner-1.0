'use strict';

const providerCache = require('../cache/memoryCache');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapColumns(cols) {
  return {
    name:             cols[0],
    lastPrice:        cols[1],
    volume:           cols[2],
    changePct:        cols[3],
    changeAbs:        cols[4],
    dayHigh:          cols[5],
    dayLow:           cols[6],
    dayOpen:          cols[7],
    prevClose:        cols[8],
    recommendation:   cols[9],
    rsi:              cols[10],
    macd:             cols[11],
    marketCap:        cols[12],
    trailingPE:       cols[13],
    priceToBook:      cols[14],
    gap:              cols[15],
    sector:           cols[16],
    description:      cols[17],
  };
}

async function getBatchQuotes(symbols, options = {}) {
  const cleanSymbols = symbols
    .map((s) => String(s).trim().toUpperCase().replace('.JK', ''))
    .filter(Boolean);
  if (!cleanSymbols.length) return { quotes:{}, failedSymbols:[], warnings:[], providerPrimaryStatus:'ok', providerFallbackStatus:'not_attempted' };
  const cacheKey = `tv:batch:${cleanSymbols.sort().join(',')}`;
  const cached = providerCache.get(cacheKey, 30 * 1000);
  if (!options.bypassCache && cached && !cached.stale) return cached.value;
  const tickers = cleanSymbols.map((s) => `IDX:${s}`);
  const payload = {
    symbols: { tickers, query: { types: [] } },
    columns: [
      'name', 'close', 'volume', 'change', 'change_abs',
      'high', 'low', 'open', 'prev_close',
      'Recommend.All', 'RSI', 'MACD.macd',
      'market_cap_basic', 'trailingPE', 'priceToBook',
      'gap', 'sector', 'description',
    ],
    range: [0, tickers.length],
  };
  try {
    const res = await fetch('https://scanner.tradingview.com/indonesia/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs || 10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const quotes = {};
    const failedSymbols = [];
    const timestamp = new Date().toISOString();
    for (const item of json.data || []) {
      const rawTicker = String(item.s || '');
      const symbol = rawTicker.replace('IDX:', '');
      const c = mapColumns(item.d);
      if (c.lastPrice != null) {
        const prevClose = c.prevClose || (c.changeAbs != null ? c.lastPrice - c.changeAbs : null);
        quotes[symbol] = {
          symbol,
          yahooSymbol: `${symbol}.JK`,
          name: c.description || c.name || symbol,
          lastPrice: c.lastPrice,
          previousClose: prevClose,
          dayHigh: c.dayHigh || c.lastPrice,
          dayLow: c.dayLow || c.lastPrice,
          volume: c.volume,
          avgVolume20: null,
          marketCap: c.marketCap,
          trailingPE: c.trailingPE,
          forwardPE: null,
          priceToBook: c.priceToBook,
          changePct: c.changePct,
          timestamp,
          marketState: null,
          source: 'tradingview',
          rsi: c.rsi,
          macd: c.macd,
          recommendation: c.recommendation,
          sector: c.sector,
        };
      } else {
        failedSymbols.push(symbol);
      }
    }
    for (const s of cleanSymbols) {
      if (!quotes[s]) failedSymbols.push(s);
    }
    const result = { quotes, failedSymbols: [...new Set(failedSymbols)], warnings:[], providerPrimaryStatus:'ok', providerFallbackStatus:'not_attempted' };
    providerCache.set(cacheKey, result);
    return result;
  } catch (err) {
    throw new Error(`TradingView scan failed: ${err.message}`);
  }
}

async function getDailyHistory(symbol, range = '1y', interval = '1d') {
  return [];
}

module.exports = { getBatchQuotes, getDailyHistory };
