'use strict';

const providerCache = require('../cache/memoryCache');
const yahoo = require('./yahooProvider');
const idxSurface = require('./idxProvider');
const tradingView = require('./tradingViewProvider');

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const CLEAN_SYMBOL = (s) => String(s || '').trim().toUpperCase().replace('.JK', '');

async function getBatchSummary(options = {}) {
  return idxSurface.getBatchStockSummary(options);
}

async function getIHSG(options = {}) {
  try {
    return await idxSurface.getIHSGQuote(options);
  } catch (_) {
    try {
      const q = await yahoo.getBatchQuotes(['^JKSE'], { bypassCache: options.bypassCache });
      return q?.quotes?.['^JKSE'] || null;
    } catch (_2) { return null; }
  }
}

async function getDailyHistory(symbol, range = '1y', interval = '1d') {
  const clean = CLEAN_SYMBOL(symbol);
  const cacheKey = `idx:data:hist:${clean}:${range}:${interval}`;
  const cached = providerCache.get(cacheKey, 300 * 1000);
  if (cached && !cached.stale) return cached.value;
  const candles = await yahoo.getDailyHistory(`${clean}.JK`, range, interval);
  providerCache.set(cacheKey, candles);
  return candles;
}

async function getBatchQuotes(symbols, options = {}) {
  const cleanSymbols = symbols.map(CLEAN_SYMBOL).filter(Boolean);
  if (!cleanSymbols.length) return { quotes:{}, failedSymbols:[], warnings:[], providerPrimaryStatus:'ok', providerFallbackStatus:'not_attempted' };

  const warnings = [];
  const allQuotes = {};
  const allFailed = [];

  // Tier 1: TradingView (real IDX data via scanner API)
  try {
    const tv = await tradingView.getBatchQuotes(cleanSymbols, options);
    for (const [s, q] of Object.entries(tv.quotes || {})) {
      allQuotes[s] = q;
      q.source = 'tradingview';
    }
  } catch (err) {
    warnings.push(`TradingView failed: ${err.message}`);
  }

  // Tier 2: IDX surface API for symbols TradingView didn't cover
  const missingTV = cleanSymbols.filter((s) => !allQuotes[s]);
  if (missingTV.length > 0) {
    try {
      const summary = await idxSurface.getBatchStockSummary(options);
      for (const s of missingTV) {
        const row = summary.get(s);
        if (row && row.lastPrice != null && row.previousClose != null) {
          allQuotes[s] = {
            symbol: s,
            yahooSymbol: `${s}.JK`,
            name: s,
            lastPrice: row.lastPrice,
            previousClose: row.previousClose,
            dayHigh: row.dayHigh || row.lastPrice,
            dayLow: row.dayLow || row.lastPrice,
            volume: row.volume,
            avgVolume20: null,
            marketCap: null,
            trailingPE: null,
            priceToBook: null,
            changePct: row.previousClose > 0 ? ((row.lastPrice - row.previousClose) / row.previousClose) * 100 : null,
            timestamp: new Date().toISOString(),
            marketState: null,
            source: 'idx-surface',
            foreignBuy: row.foreignBuy,
            foreignSell: row.foreignSell,
            netBuy: row.netBuy,
          };
        }
      }
    } catch (err) {
      warnings.push(`IDX surface failed: ${err.message}`);
    }
  }

  // Tier 3: Yahoo for still-missing symbols
  const missingAll = cleanSymbols.filter((s) => !allQuotes[s]);
  if (missingAll.length > 0) {
    try {
      const yh = await yahoo.getBatchQuotes(missingAll, options);
      for (const [s, q] of Object.entries(yh.quotes || {})) {
        if (!allQuotes[s]) {
          q.source = 'yahoo-finance+fallback';
          allQuotes[s] = q;
        }
      }
    } catch (err) {
      warnings.push(`Yahoo fallback failed: ${err.message}`);
    }
  }

  for (const s of cleanSymbols) {
    if (!allQuotes[s]) allFailed.push(s);
  }

  const sources = [...new Set(Object.values(allQuotes).map((q) => q.source).filter(Boolean))];
  return {
    quotes: allQuotes,
    failedSymbols: allFailed,
    warnings,
    providerPrimaryStatus: allQuotes[symbols[0]] ? 'ok' : 'error',
    providerFallbackStatus: sources.some((s) => s.includes('fallback') || s === 'yahoo-finance') ? 'ok' : 'not_attempted',
    sources,
  };
}

module.exports = { getBatchQuotes, getDailyHistory, getIHSG, getBatchSummary };
