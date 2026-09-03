'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const enrich = require('../api/enrich');
const telmi = require('../lib/providers/telmiProvider');
const stockbit = require('../lib/providers/stockbitGatewayProvider');

function call(query = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = { method, query };
    const res = {
      headers:{}, statusCode:200,
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode:this.statusCode, body, headers:this.headers }); },
      end() { resolve({ statusCode:this.statusCode, body:null, headers:this.headers }); },
    };
    Promise.resolve(enrich(req, res)).catch(reject);
  });
}

function response(body, status = 200) {
  return { ok:status >= 200 && status < 300, status, json:async () => body };
}

function saveEnv() {
  return {
    TELMI_API_KEY:process.env.TELMI_API_KEY,
    TELMI_API_BASE_URL:process.env.TELMI_API_BASE_URL,
    STOCKBIT_GATEWAY_URL:process.env.STOCKBIT_GATEWAY_URL,
    STOCKBIT_GATEWAY_TOKEN:process.env.STOCKBIT_GATEWAY_TOKEN,
    STOCKBIT_GATEWAY_TIMEOUT_MS:process.env.STOCKBIT_GATEWAY_TIMEOUT_MS,
  };
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  telmi.resetCache();
  stockbit.resetCache();
}

test('enrichment is an optional no-op when providers are not configured', async () => {
  const saved = saveEnv();
  delete process.env.TELMI_API_KEY;
  delete process.env.STOCKBIT_GATEWAY_URL;
  delete process.env.STOCKBIT_GATEWAY_TOKEN;
  telmi.resetCache();
  stockbit.resetCache();
  try {
    const result = await call({ symbols:'BBCA,BBRI' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.sources.telmi.status, 'disabled');
    assert.equal(result.body.sources.stockbit.status, 'disabled');
    assert.deepEqual(result.body.enrichments, {});
    assert.equal(result.body.scoringImpact, 'none');
  } finally { restoreEnv(saved); }
});

test('Telmi signals and top picks are normalized without changing core score', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  process.env.TELMI_API_KEY = 'unit-test-key';
  process.env.TELMI_API_BASE_URL = 'https://telmi.example/api/v1/open';
  delete process.env.STOCKBIT_GATEWAY_URL;
  telmi.resetCache();
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers['x-api-key'], 'unit-test-key');
    if (String(url).endsWith('/market/stock-signals')) return response({ success:true, data:[{
      symbol:'BBCA', signal:'BUY', indicator:'Smart Money Accumulation', price:9600,
      areaBuyMin:9500, areaBuyMax:9650, tp1:9900, sl:9300, status:'ACTIVE', timestamp:'2026-09-03T02:00:00Z',
    }] });
    return response({ success:true, data:[{ kode_saham:'BBCA', per:18.2, pbv:4.1, roe:21.5, price:9600 }] });
  };
  try {
    const result = await call({ symbols:'BBCA,TLKM' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sources.telmi.status, 'ok');
    assert.equal(result.body.sources.telmi.matched, 1);
    assert.equal(result.body.enrichments.BBCA.telmi.signal, 'BUY');
    assert.equal(result.body.enrichments.BBCA.telmi.topPick.pe, 18.2);
    assert.equal(result.body.enrichments.BBCA.consensus.status, 'single_source');
    assert.equal('score' in result.body.enrichments.BBCA, false);
    assert.equal(result.body.scoringImpact, 'none');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('Telmi plan restrictions produce partial enrichment rather than scan failure', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  process.env.TELMI_API_KEY = 'unit-test-key';
  process.env.TELMI_API_BASE_URL = 'https://telmi.example/api/v1/open';
  delete process.env.STOCKBIT_GATEWAY_URL;
  telmi.resetCache();
  globalThis.fetch = async (url) => String(url).endsWith('/market/stock-signals')
    ? response({ success:false }, 403)
    : response({ success:true, data:[{ kode_saham:'BBRI', per:12.5 }] });
  try {
    const result = await call({ symbols:'BBRI' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sources.telmi.status, 'partial');
    assert.deepEqual(result.body.sources.telmi.errors, ['TELMI_SIGNALS_HTTP_403']);
    assert.equal(result.body.enrichments.BBRI.telmi.topPick.pe, 12.5);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('Stockbit gateway data is allowlisted and merged as read-only confirmation', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  delete process.env.TELMI_API_KEY;
  process.env.STOCKBIT_GATEWAY_URL = 'https://stockbit-gateway.example/v1/enrich';
  process.env.STOCKBIT_GATEWAY_TOKEN = 'gateway-test-token-with-at-least-32-characters';
  stockbit.resetCache();
  globalThis.fetch = async (url, options) => {
    assert.equal(url, process.env.STOCKBIT_GATEWAY_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer gateway-test-token-with-at-least-32-characters');
    assert.deepEqual(JSON.parse(options.body), { symbols:['BBCA'] });
    return response({ ok:true, enrichments:{ BBCA:{
      sentiment:'bullish', summary:'Broker flow positive', secretField:'must-not-pass',
      brokerSummary:{ netBuyValue:1250000000, topBuyers:[{ broker:'YP', value:800000000 }] },
      orderbook:{ imbalance:18.4, bestBid:9575, bestOffer:9600 },
    } } });
  };
  try {
    const result = await call({ symbols:'BBCA' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sources.stockbit.status, 'ok');
    assert.equal(result.body.enrichments.BBCA.stockbit.brokerSummary.netBuyValue, 1250000000);
    assert.equal(result.body.enrichments.BBCA.stockbit.secretField, undefined);
    assert.equal(result.body.enrichments.BBCA.consensus.status, 'single_source');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('Stockbit gateway rejects plaintext remote URLs and weak bearer tokens', async () => {
  const saved = saveEnv();
  const originalFetch = globalThis.fetch;
  delete process.env.TELMI_API_KEY;
  process.env.STOCKBIT_GATEWAY_URL = 'http://stockbit-gateway.example/v1/enrich';
  process.env.STOCKBIT_GATEWAY_TOKEN = 'short-token';
  stockbit.resetCache();
  globalThis.fetch = async () => { throw new Error('fetch must not run for unsafe configuration'); };
  try {
    const result = await call({ symbols:'BBCA' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sources.stockbit.status, 'misconfigured');
    assert.deepEqual(result.body.sources.stockbit.errors, ['STOCKBIT_GATEWAY_CONFIG_INVALID']);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test('enrichment validates symbol requests', async () => {
  assert.equal((await call({})).statusCode, 400);
  const invalid = await call({ symbols:'BBCA,$BAD' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, 'INVALID_SYMBOLS');
  const tooMany = await call({ symbols:Array.from({ length:21 }, (_, index) => `A${index}`).join(',') });
  assert.equal(tooMany.statusCode, 400);
  assert.equal(tooMany.body.error, 'TOO_MANY_SYMBOLS');
});
