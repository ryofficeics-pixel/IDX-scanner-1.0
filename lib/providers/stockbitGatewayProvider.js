'use strict';

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_SYMBOLS = 20;
const cache = new Map();

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function asText(value, max = 240) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function symbolOf(row, fallback) {
  const raw = row?.symbol ?? row?.code ?? row?.ticker ?? row?.stockCode ?? fallback;
  return asText(raw, 16)?.toUpperCase().replace(/\.JK$/, '') || null;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

function brokerRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 10).map((row) => compact({
    broker:asText(row?.broker ?? row?.code ?? row?.name, 40),
    value:asNumber(row?.value ?? row?.netValue ?? row?.net_value),
    lot:asNumber(row?.lot ?? row?.lots ?? row?.volume),
    average:asNumber(row?.average ?? row?.avg ?? row?.avgPrice ?? row?.avg_price),
  })).filter((row) => Object.keys(row).length);
}

function normalizeRow(row) {
  const quote = row?.quote || {};
  const broker = row?.brokerSummary ?? row?.broker_summary ?? {};
  const book = row?.orderbook ?? row?.orderBook ?? row?.order_book ?? {};
  const fundamentals = row?.fundamentals ?? row?.fundamental ?? {};
  return compact({
    signal:asText(row?.signal ?? row?.recommendation, 40),
    sentiment:asText(row?.sentiment ?? row?.bias, 40),
    summary:asText(row?.summary ?? row?.reason, 300),
    timestamp:asText(row?.timestamp ?? row?.asOf ?? row?.updatedAt ?? row?.updated_at, 64),
    quote:compact({
      price:asNumber(quote.price ?? quote.lastPrice ?? row?.price),
      bid:asNumber(quote.bid ?? quote.bestBid),
      offer:asNumber(quote.offer ?? quote.ask ?? quote.bestOffer),
      timestamp:asText(quote.timestamp ?? quote.asOf, 64),
    }),
    brokerSummary:compact({
      netBuyValue:asNumber(broker.netBuyValue ?? broker.net_buy_value ?? broker.netBuy ?? row?.netBuyValue),
      foreignNet:asNumber(broker.foreignNet ?? broker.foreign_net),
      topBuyers:brokerRows(broker.topBuyers ?? broker.top_buyers),
      topSellers:brokerRows(broker.topSellers ?? broker.top_sellers),
      timestamp:asText(broker.timestamp ?? broker.asOf, 64),
    }),
    orderbook:compact({
      imbalance:asNumber(book.imbalance ?? book.imbalancePct ?? book.imbalance_pct),
      bestBid:asNumber(book.bestBid ?? book.best_bid),
      bestOffer:asNumber(book.bestOffer ?? book.best_offer ?? book.bestAsk),
      bidDepth:asNumber(book.bidDepth ?? book.bid_depth),
      offerDepth:asNumber(book.offerDepth ?? book.offer_depth),
      timestamp:asText(book.timestamp ?? book.asOf, 64),
    }),
    fundamentals:compact({
      pe:asNumber(fundamentals.pe ?? fundamentals.per),
      pbv:asNumber(fundamentals.pbv),
      roe:asNumber(fundamentals.roe),
      der:asNumber(fundamentals.der),
      marketCap:asNumber(fundamentals.marketCap ?? fundamentals.market_cap),
    }),
  });
}

function rowsFrom(payload) {
  const data = payload?.enrichments ?? payload?.data ?? payload?.results ?? payload;
  if (Array.isArray(data)) return data.map((row) => [symbolOf(row), row]);
  if (data && typeof data === 'object') return Object.entries(data).map(([symbol, row]) => [symbolOf(row, symbol), row]);
  return [];
}

function baseResult(status, configured, errors = []) {
  return {
    provider:'stockbit-gateway', configured, status, fetchedAt:null,
    matched:0, cacheHit:false, errors, enrichments:{},
  };
}

function validGatewayUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function requestTimeout(options) {
  const configured = options.timeoutMs ?? process.env.STOCKBIT_GATEWAY_TIMEOUT_MS;
  const parsed = Number(configured);
  return Math.max(1000, Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 9000, 20000));
}

function readConfiguration() {
  const gatewayUrl = String(process.env.STOCKBIT_GATEWAY_URL || '').trim();
  const token = String(process.env.STOCKBIT_GATEWAY_TOKEN || '').trim();
  if (!gatewayUrl && !token) return { status:'disabled', gatewayUrl, token };
  if (!validGatewayUrl(gatewayUrl) || token.length < 32) return { status:'misconfigured', gatewayUrl, token };
  return { status:'configured', gatewayUrl, token };
}

function configurationStatus() {
  const { status } = readConfiguration();
  return { configured:status === 'configured', status };
}

async function getEnrichment(symbols, options = {}) {
  const { status:configuration, gatewayUrl, token } = readConfiguration();
  const requested = Array.from(new Set((symbols || []).map((s) => String(s).toUpperCase().replace(/\.JK$/, '')))).slice(0, MAX_SYMBOLS);
  if (configuration === 'disabled') return baseResult('disabled', false);
  if (configuration === 'misconfigured') return baseResult('misconfigured', false, ['STOCKBIT_GATEWAY_CONFIG_INVALID']);

  const key = `${gatewayUrl}|${requested.slice().sort().join(',')}`;
  const cached = cache.get(key);
  if (!options.bypassCache && cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return { ...cached.value, cacheHit:true };
  }

  const controller = new AbortController();
  const timeoutMs = requestTimeout(options);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(gatewayUrl, {
      method:'POST',
      headers:{ Accept:'application/json', 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
      body:JSON.stringify({ symbols:requested }),
      signal:controller.signal,
    });
    if (!response.ok) throw new Error(`STOCKBIT_GATEWAY_HTTP_${response.status}`);
    const payload = await response.json();
    if (payload?.ok === false || payload?.success === false) throw new Error('STOCKBIT_GATEWAY_REJECTED');
    const requestedSet = new Set(requested);
    const enrichments = {};
    for (const [symbol, row] of rowsFrom(payload)) {
      if (!symbol || !requestedSet.has(symbol) || !row || typeof row !== 'object') continue;
      enrichments[symbol] = { stockbit:normalizeRow(row) };
    }
    const value = {
      provider:'stockbit-gateway', configured:true, status:'ok',
      fetchedAt:new Date().toISOString(), matched:Object.keys(enrichments).length,
      cacheHit:false, errors:[], enrichments,
    };
    cache.set(key, { savedAt:Date.now(), value });
    return value;
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'STOCKBIT_GATEWAY_TIMEOUT'
      : String(error?.message || '').startsWith('STOCKBIT_GATEWAY_') ? String(error.message).slice(0, 100)
      : 'STOCKBIT_GATEWAY_FAILED';
    return baseResult('error', true, [code]);
  } finally {
    clearTimeout(timer);
  }
}

function resetCache() { cache.clear(); }

module.exports = { getEnrichment, configurationStatus, resetCache };
