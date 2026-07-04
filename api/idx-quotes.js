'use strict';

const IDX_UNIVERSE = require('../data/idx-symbols.json');
const IDX_SYMBOL_SET = new Set(IDX_UNIVERSE.map((row) => row.symbol));
const DEFAULT_SYMBOLS = IDX_UNIVERSE.slice(0, 120).map((row) => row.symbol);
const IHSG_SYM = '^JKSE';
const MAX_REQUEST_SYMBOLS = 180;
const TTL_MARKET_OPEN_MS = 60 * 1000;
const TTL_MARKET_CLOSE_MS = 15 * 60 * 1000;
let CACHE = { payload: null, fetchedAt: 0, key: null };

function sampleQuotes(symbols) {
  return Object.fromEntries(symbols.map((symbol) => [symbol, {
    symbol, price:null, prevClose:null, high:null, low:null, volume:null, pctChg:null,
    asOf:null, source:'local-sample', priceFreshness:'LOCAL_SAMPLE', flow:null,
    dataMode:'LOCAL_SAMPLE', error:'LIVE_PRICE_UNAVAILABLE'
  }]));
}

const { setCors } = require('../lib/utils/http');
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function send(res, status, body) { res.status(status).json(body); }
function symbolsFromQuery(req) {
  const raw = req.query && req.query.symbols ? String(req.query.symbols) : '';
  const symbols = raw
    ? raw.split(',')
      .map((s) => s.trim().toUpperCase().replace('.JK','').replace(/[^A-Z0-9]/g, ''))
      .filter((s) => s && IDX_SYMBOL_SET.has(s))
    : DEFAULT_SYMBOLS;
  const unique = [...new Set(symbols)].slice(0, MAX_REQUEST_SYMBOLS);
  return unique.length ? unique : DEFAULT_SYMBOLS;
}
function isMarketOpen() {
  const wib = new Date(new Date().toLocaleString('en-US', { timeZone:'Asia/Jakarta' }));
  const d = wib.getDay(), h = wib.getHours();
  return d >= 1 && d <= 5 && h >= 9 && h < 15;
}
function cacheTTL() { return isMarketOpen() ? TTL_MARKET_OPEN_MS : TTL_MARKET_CLOSE_MS; }
function cacheFresh(key) { return CACHE.payload && CACHE.key === key && Date.now() - CACHE.fetchedAt < cacheTTL(); }
function normalizeQuote(symbol, raw, provider, freshness) {
  const price = num(raw.price);
  const prevClose = num(raw.prevClose);
  return {
    symbol,
    price,
    prevClose,
    high: num(raw.high),
    low: num(raw.low),
    volume: num(raw.volume),
    pctChg: num(raw.pctChg) ?? (price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null),
    asOf: nowISO(),
    source: provider,
    priceFreshness: freshness,
    flow: null,
    dataMode: price != null ? 'PRICE_ONLY' : 'NO_DATA',
  };
}
async function fetchJson(url, timeoutMs) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; IDXScanner/2.0)',
    Accept: 'application/json',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function fetchV8(symbol) {
  const yf = symbol === '__IHSG' ? IHSG_SYM : `${symbol}.JK`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yf)}?interval=1d&range=1d`;
  const json = await fetchJson(url, 8000);
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta || num(meta.regularMarketPrice) == null) throw new Error('NO_PRICE');
  const price = num(meta.regularMarketPrice);
  const prevClose = num(meta.chartPreviousClose ?? meta.previousClose);
  return {
    price,
    prevClose,
    high: num(meta.regularMarketDayHigh) ?? price,
    low: num(meta.regularMarketDayLow) ?? price,
    volume: num(meta.regularMarketVolume),
    pctChg: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    marketState: meta.marketState || null,
  };
}
async function fetchV7(symbols) {
  const yfSymbols = [IHSG_SYM, ...symbols.map((s) => `${s}.JK`)].join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yfSymbols)}`;
  const json = await fetchJson(url, 12000);
  const list = json?.quoteResponse?.result || [];
  const out = {};
  for (const q of list) {
    const symbol = q.symbol === IHSG_SYM ? '__IHSG' : String(q.symbol || '').replace('.JK','');
    const price = num(q.regularMarketPrice);
    if (price == null) continue;
    out[symbol] = {
      price,
      prevClose: num(q.regularMarketPreviousClose),
      high: num(q.regularMarketDayHigh) ?? price,
      low: num(q.regularMarketDayLow) ?? price,
      volume: num(q.regularMarketVolume),
      pctChg: num(q.regularMarketChangePercent),
      marketState: q.marketState || null,
    };
  }
  return out;
}
async function fetchPrices(symbols) {
  const quotes = {};
  const errors = [];
  const warnings = [];
  let ihsg = null;

  try {
    const v7 = await fetchV7(symbols);
    if (v7.__IHSG) {
      const raw = v7.__IHSG;
      ihsg = { ...raw, chg: raw.price != null && raw.prevClose != null ? raw.price - raw.prevClose : null, asOf: nowISO(), source:'yahoo-finance-v7' };
    }
    for (const symbol of symbols) {
      if (v7[symbol]) quotes[symbol] = normalizeQuote(symbol, v7[symbol], 'yahoo-finance-v7', 'LIVE_PRICE');
    }
  } catch (error) {
    warnings.push(`v7 batch failed: ${error.message}`);
  }

  const missing = symbols.filter((s) => !quotes[s]).slice(0, 40);
  const all = [...(!ihsg ? ['__IHSG'] : []), ...missing];
  await Promise.allSettled(all.map(async (symbol) => {
    try {
      const raw = await fetchV8(symbol);
      if (symbol === '__IHSG') {
        ihsg = { ...raw, chg: raw.price != null && raw.prevClose != null ? raw.price - raw.prevClose : null, asOf: nowISO(), source:'yahoo-finance-v8' };
      } else {
        quotes[symbol] = normalizeQuote(symbol, raw, 'yahoo-finance-v8', 'LIVE_PRICE');
      }
    } catch (error) {
      errors.push({ symbol, provider:'yahoo-finance-v8', error:error.message });
    }
  }));

  const skipped = symbols.filter((s) => !quotes[s]).length - missing.length;
  if (skipped > 0) {
    warnings.push(`${skipped} symbols skipped from v8 fallback to keep request within runtime budget`);
  }

  for (const symbol of symbols) {
    if (!quotes[symbol]) {
      quotes[symbol] = {
        symbol, price:null, prevClose:null, high:null, low:null, volume:null, pctChg:null,
        asOf:nowISO(), source:'none', priceFreshness:'NO_DATA', flow:null,
        dataMode:'NO_DATA', error:'QUOTE_FETCH_FAILED',
      };
    }
  }

  return { quotes, ihsg, errors, warnings };
}
async function supabaseSelect(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const res = await fetch(`${url.replace(/\/$/,'')}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  return await res.json();
}
async function fetchFlow(symbols) {
  try {
    const list = await supabaseSelect(`idx_flow_data?symbol=in.(${symbols.join(',')})&order=trade_date.desc`);
    if (!Array.isArray(list)) return { flowBySymbol:{}, provider:'none', warnings:['Supabase flow env not configured'] };
    const flowBySymbol = {};
    for (const row of list) {
      if (flowBySymbol[row.symbol]) continue;
      flowBySymbol[row.symbol] = {
        brokerBuy:num(row.broker_buy), brokerSell:num(row.broker_sell),
        foreignBuy:num(row.foreign_buy), foreignSell:num(row.foreign_sell),
        netBuy:num(row.net_buy), freqBuy:num(row.freq_buy), freqSell:num(row.freq_sell),
        volumeAvg5d:num(row.volume_avg5d), tradeDate:row.trade_date,
        source:row.source || 'supabase', updatedAt:row.updated_at,
      };
    }
    return { flowBySymbol, provider:'supabase', warnings:[] };
  } catch (error) {
    return { flowBySymbol:{}, provider:'error', warnings:[`Supabase flow unavailable: ${error.message}`] };
  }
}
function resolveDataMode(quote, flow) {
  if (!quote || quote.price == null) return 'NO_DATA';
  if (!flow) return quote.dataMode === 'LOCAL_SAMPLE' ? 'LOCAL_SAMPLE' : 'PRICE_ONLY';
  const fields = ['brokerBuy','brokerSell','foreignBuy','foreignSell','netBuy','freqBuy','freqSell'];
  const present = fields.filter((k) => Number.isFinite(Number(flow[k])));
  const today = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Jakarta' });
  if (flow.tradeDate && flow.tradeDate !== today) return 'FLOW_STALE';
  if (present.length === fields.length) return 'FULL_FLOW';
  if (present.length > 0) return 'PARTIAL_FLOW';
  return 'PRICE_ONLY';
}
function mergeFlow(quotes, flowBySymbol) {
  for (const [symbol, quote] of Object.entries(quotes)) {
    const flow = flowBySymbol[symbol] || null;
    quote.flow = flow;
    if (flow) {
      Object.assign(quote, {
        brokerBuy:flow.brokerBuy, brokerSell:flow.brokerSell,
        foreignBuy:flow.foreignBuy, foreignSell:flow.foreignSell,
        netBuy:flow.netBuy, freqBuy:flow.freqBuy, freqSell:flow.freqSell,
        volumeAvg5d:flow.volumeAvg5d, flowTradeDate:flow.tradeDate,
        flowSource:flow.source, flowUpdatedAt:flow.updatedAt,
      });
    }
    quote.dataMode = resolveDataMode(quote, flow);
  }
}
function buildPayload({ symbols, quotes, ihsg, errors, warnings, freshness, priceProvider, flowProvider }) {
  const failed = symbols.filter((s) => quotes[s]?.dataMode === 'NO_DATA');
  return {
    status:'ok',
    source:'web',
    provider:priceProvider,
    asOf:nowISO(),
    freshness,
    priceProvider,
    flowProvider,
    symbolsRequested:symbols.length,
    symbolsReturned:Object.keys(quotes).length,
    symbolsFailed:failed.length,
    IHSG: ihsg || { price:null, chg:null, pctChg:null, high:null, low:null, marketState:'UNKNOWN', asOf:nowISO(), source:'none' },
    quotes,
    errors,
    warnings,
  };
}
module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { status:'error', error:'METHOD_NOT_ALLOWED' });

  const symbols = symbolsFromQuery(req);
  const cacheKey = symbols.join(',');
  const force = req.query?.force === 'true';
  if (!force && cacheFresh(cacheKey)) {
    const cached = JSON.parse(JSON.stringify(CACHE.payload));
    cached.freshness = 'STALE_PRICE';
    cached.quotes && Object.values(cached.quotes).forEach((q) => { q.priceFreshness = 'STALE_PRICE'; });
    cached.fromCache = true;
    return send(res, 200, cached);
  }

  const price = await fetchPrices(symbols);
  const flow = await fetchFlow(symbols);
  mergeFlow(price.quotes, flow.flowBySymbol);

  const liveCount = Object.values(price.quotes).filter((q) => q.price != null).length;
  let payload;
  if (liveCount > 0) {
    payload = buildPayload({
      symbols, quotes:price.quotes, ihsg:price.ihsg, errors:price.errors,
      warnings:[...price.warnings, ...flow.warnings],
      freshness:'LIVE_PRICE', priceProvider:'yahoo-finance', flowProvider:flow.provider,
    });
    CACHE = { payload, fetchedAt:Date.now(), key:cacheKey };
  } else if (CACHE.payload) {
    payload = JSON.parse(JSON.stringify(CACHE.payload));
    payload.freshness = 'STALE_PRICE';
    payload.errors = price.errors;
    payload.warnings = [...(payload.warnings || []), 'Live providers failed; returned stale backend cache', ...price.warnings, ...flow.warnings];
    payload.fromCache = true;
  } else {
    payload = buildPayload({
      symbols, quotes:sampleQuotes(symbols), ihsg:null, errors:price.errors,
      warnings:['All live providers failed. Local sample is not live market data.', ...price.warnings, ...flow.warnings],
      freshness:'LOCAL_SAMPLE', priceProvider:'local-sample', flowProvider:flow.provider,
    });
  }
  return send(res, 200, payload);
};
