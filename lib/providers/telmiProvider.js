'use strict';

const DEFAULT_BASE_URL = 'https://api-finance.telmi.id/api/v1/open';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SYMBOLS = 20;

let localCache = null;

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

function stockSymbol(row) {
  const raw = row?.symbol ?? row?.kode_saham ?? row?.stockCode ?? row?.stock_code ?? row?.ticker ?? row?.code;
  return asText(raw, 16)?.toUpperCase().replace(/\.JK$/, '') || null;
}

function listFrom(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'results', 'items', 'stocks', 'signals', 'topPicks', 'top_picks']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function normalizeSignal(row) {
  return {
    signal:asText(row?.signal ?? row?.recommendation, 40),
    indicator:asText(row?.indicator ?? row?.reason ?? row?.description, 300),
    price:asNumber(row?.price ?? row?.lastPrice ?? row?.last_price),
    areaBuyMin:asNumber(row?.areaBuyMin ?? row?.area_buy_min ?? row?.buyMin),
    areaBuyMax:asNumber(row?.areaBuyMax ?? row?.area_buy_max ?? row?.buyMax),
    tp1:asNumber(row?.tp1 ?? row?.target1),
    tp2:asNumber(row?.tp2 ?? row?.target2),
    tp3:asNumber(row?.tp3 ?? row?.target3),
    tp4:asNumber(row?.tp4 ?? row?.target4),
    sl:asNumber(row?.sl ?? row?.stopLoss ?? row?.stop_loss),
    status:asText(row?.status, 40),
    timestamp:asText(row?.timestamp ?? row?.updatedAt ?? row?.updated_at, 64),
  };
}

function normalizeTopPick(row) {
  return {
    rank:asNumber(row?.rank ?? row?.ranking),
    price:asNumber(row?.price ?? row?.lastPrice ?? row?.last_price),
    pe:asNumber(row?.per ?? row?.pe),
    pbv:asNumber(row?.pbv),
    roe:asNumber(row?.roe),
    roa:asNumber(row?.roa),
    der:asNumber(row?.der),
    marketCap:asNumber(row?.mkt_cap ?? row?.marketCap ?? row?.market_cap),
    updatedAt:asText(row?.updatedAt ?? row?.updated_at ?? row?.timestamp, 64),
  };
}

function errorCode(prefix, error) {
  const message = String(error?.message || error || 'UNKNOWN');
  if (message.startsWith(prefix + '_')) return message.slice(0, 100);
  return `${prefix}_FAILED`;
}

async function request(baseUrl, apiKey, path, label, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method:'GET',
      headers:{ Accept:'application/json', 'x-api-key':apiKey },
      signal:controller.signal,
    });
    if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
    const payload = await response.json();
    if (payload?.success === false) throw new Error(`${label}_REJECTED`);
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${label}_TIMEOUT`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function disabledResult(status = 'disabled', errors = []) {
  return {
    provider:'telmi',
    configured:false,
    status,
    fetchedAt:null,
    matched:0,
    cacheHit:false,
    endpointStatus:{ signals:'not_attempted', topPicks:'not_attempted' },
    errors,
    enrichments:{},
  };
}

async function getEnrichment(symbols, options = {}) {
  const apiKey = String(process.env.TELMI_API_KEY || '').trim();
  const baseUrl = String(process.env.TELMI_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const requested = Array.from(new Set((symbols || []).map((s) => String(s).toUpperCase().replace(/\.JK$/, '')))).slice(0, MAX_SYMBOLS);
  if (!apiKey) return disabledResult();
  if (!/^https?:\/\//i.test(baseUrl)) return disabledResult('misconfigured', ['TELMI_BASE_URL_INVALID']);

  const signature = `${baseUrl}|${apiKey}`;
  const now = Date.now();
  let dataset;
  let cacheHit = false;
  if (!options.bypassCache && localCache?.signature === signature && now - localCache.savedAt < CACHE_TTL_MS) {
    dataset = localCache.dataset;
    cacheHit = true;
  } else {
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 9000, 20000));
    const [signalsResult, picksResult] = await Promise.allSettled([
      request(baseUrl, apiKey, '/market/stock-signals', 'TELMI_SIGNALS', timeoutMs),
      request(baseUrl, apiKey, '/stocks/top-picks', 'TELMI_TOP_PICKS', timeoutMs),
    ]);
    dataset = {
      signals:signalsResult.status === 'fulfilled' ? listFrom(signalsResult.value) : [],
      topPicks:picksResult.status === 'fulfilled' ? listFrom(picksResult.value) : [],
      endpointStatus:{
        signals:signalsResult.status === 'fulfilled' ? 'ok' : 'error',
        topPicks:picksResult.status === 'fulfilled' ? 'ok' : 'error',
      },
      errors:[
        ...(signalsResult.status === 'rejected' ? [errorCode('TELMI_SIGNALS', signalsResult.reason)] : []),
        ...(picksResult.status === 'rejected' ? [errorCode('TELMI_TOP_PICKS', picksResult.reason)] : []),
      ],
      fetchedAt:new Date().toISOString(),
    };
    if (Object.values(dataset.endpointStatus).some((status) => status === 'ok')) {
      localCache = { signature, savedAt:now, dataset };
    }
  }

  const requestedSet = new Set(requested);
  const enrichments = {};
  for (const row of dataset.signals) {
    const symbol = stockSymbol(row);
    if (!symbol || !requestedSet.has(symbol)) continue;
    enrichments[symbol] = { telmi:{ ...normalizeSignal(row) } };
  }
  for (const row of dataset.topPicks) {
    const symbol = stockSymbol(row);
    if (!symbol || !requestedSet.has(symbol)) continue;
    const current = enrichments[symbol]?.telmi || {};
    enrichments[symbol] = { telmi:{ ...current, topPick:normalizeTopPick(row) } };
  }

  const okCount = Object.values(dataset.endpointStatus).filter((s) => s === 'ok').length;
  return {
    provider:'telmi',
    configured:true,
    status:okCount === 2 ? 'ok' : okCount === 1 ? 'partial' : 'error',
    fetchedAt:dataset.fetchedAt,
    matched:Object.keys(enrichments).length,
    cacheHit,
    endpointStatus:dataset.endpointStatus,
    errors:dataset.errors,
    enrichments,
  };
}

function resetCache() { localCache = null; }

module.exports = { getEnrichment, resetCache };
