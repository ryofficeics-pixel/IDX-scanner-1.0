'use strict';

const providerCache = require('../cache/memoryCache');
const redisCache = require('../cache/redisCache');
const yahoo = require('./yahooProvider');
const idxSurface = require('./idxProvider');

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const CLEAN_SYMBOL = (s) => String(s || '').trim().toUpperCase().replace('.JK', '');

async function fetchJson(url, { timeoutMs = 8000, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':'Mozilla/5.0 (compatible; IDXScanner/2.1; +https://vercel.app)',
          Accept:'application/json,text/plain,*/*',
          Referer:'https://www.idx.co.id/en/market-data/trading-summary/stock-summary',
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

function normalizeStockRow(row) {
  const symbol = CLEAN_SYMBOL(row?.StockCode ?? row?.stockCode ?? row?.Code ?? row?.code);
  if (!symbol) return null;
  const fb = num(row?.ForeignBuy ?? row?.foreignBuy ?? null);
  const fs = num(row?.ForeignSell ?? row?.foreignSell ?? null);
  return {
    symbol,
    lastPrice:     num(row?.Close  ?? row?.close  ?? row?.LastPrice ?? row?.lastPrice),
    previousClose:  num(row?.Previous ?? row?.previous ?? row?.PrevClose ?? row?.prevClose),
    open:          num(row?.OpenPrice ?? row?.openPrice ?? row?.Open ?? row?.open),
    dayHigh:       num(row?.High   ?? row?.high),
    dayLow:        num(row?.Low    ?? row?.low),
    volume:        num(row?.Volume ?? row?.volume),
    value:         num(row?.Value  ?? row?.value),
    freq:          num(row?.Frequency ?? row?.frequency),
    foreignBuy:    fb,
    foreignSell:   fs,
    brokerBuy:     num(row?.Bid    ?? row?.bid    ?? row?.BrokerBuy  ?? null),
    brokerSell:    num(row?.Offer  ?? row?.offer  ?? row?.BrokerSell ?? null),
    netBuy:        (fb != null && fs != null) ? fb - fs : num(row?.NetBuy ?? null),
    tradeDate:     String(row?.Date ?? row?.date ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    source:        'idx-surface',
  };
}

async function getBatchSummary(options = {}) {
  const cacheKey = 'idx:data:summary';
  const cached = providerCache.get(cacheKey, 90 * 1000);
  if (!options.bypassCache && cached && !cached.stale) return cached.value;
  const result = new Map();
  try {
    const date = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Jakarta' }).replace(/-/g, '');
    const url = `https://www.idx.co.id/umbraco/Surface/TradingSummary/GetStockSummary?start=0&length=9999&date=${date}`;
    const json = await fetchJson(url, { timeoutMs: 10000 });
    const rows = Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.Data) ? json.Data
      : Array.isArray(json) ? json : [];
    for (const row of rows) {
      const norm = normalizeStockRow(row);
      if (norm && norm.symbol && norm.lastPrice != null) result.set(norm.symbol, norm);
    }
  } catch (err) {
    console.warn(`IDX batch summary failed: ${err.message}`);
  }
  if (result.size > 0) providerCache.set(cacheKey, result);
  return result;
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
  const summary = await getBatchSummary(options);
  const quotes = {};
  const failedSymbols = [];
  const warnings = [];
  for (const s of cleanSymbols) {
    const row = summary.get(s);
    if (row && row.lastPrice != null && row.previousClose != null) {
      quotes[s] = {
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
        forwardPE: null,
        priceToBook: null,
        changePct: row.previousClose > 0 ? ((row.lastPrice - row.previousClose) / row.previousClose) * 100 : null,
        timestamp: new Date().toISOString(),
        marketState: null,
        source: 'idx-surface',
        foreignBuy: row.foreignBuy,
        foreignSell: row.foreignSell,
        netBuy: row.netBuy,
        brokerBuy: row.brokerBuy,
        brokerSell: row.brokerSell,
      };
    } else {
      failedSymbols.push(s);
    }
  }
  if (failedSymbols.length) warnings.push(`IDX surface missing ${failedSymbols.length}/${cleanSymbols.length} symbols`);
  return { quotes, failedSymbols, warnings, providerPrimaryStatus:'ok', providerFallbackStatus:'not_attempted' };
}

module.exports = { getBatchQuotes, getDailyHistory, getIHSG, getBatchSummary };
