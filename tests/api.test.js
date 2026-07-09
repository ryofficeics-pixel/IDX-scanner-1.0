'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const scan = require('../api/scan');
const health = require('../api/health');
const alert = require('../api/alert');

function call(handler, query = {}, { method = 'GET', body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, query, body };
    const res = {
      headers:{},
      statusCode:200,
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(b) { resolve({ statusCode:this.statusCode, body:b }); },
      end() { resolve({ statusCode:this.statusCode, body:null }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function callPost(handler, body = {}) {
  return call(handler, {}, { method:'POST', body });
}

test('scan returns enhanced diagnostics', async () => {
  const { body } = await call(scan, { symbols:'BBCA,BBRI,BMRI', debug:'1' });
  assert.equal(body.ok, true);
  assert.equal(typeof body.diagnostics.providerPrimaryStatus, 'string');
  assert.equal(typeof body.diagnostics.providerFallbackStatus, 'string');
  assert.equal(typeof body.diagnostics.providerLatencyMs, 'number');
  assert.equal(typeof body.diagnostics.scanStartedAt, 'string');
  assert.equal(typeof body.diagnostics.scanFinishedAt, 'string');
  assert.equal(typeof body.diagnostics.validRatio, 'number');
  assert.equal(typeof body.diagnostics.noDataRatio, 'number');
});

test('force provider fail returns no fake recommendations', async () => {
  const { body } = await call(scan, { symbols:'BBCA,BBRI', debug:'1', forceProviderFail:'1' });
  const flat = Object.values(body.recommendations).flat();
  assert.equal(body.ok, true);
  assert.equal(body.summary.valid, 0);
  assert.equal(body.summary.noData, 2);
  assert.equal(flat.every((s) => s.action === 'NO_DATA' && s.lastPrice == null), true);
});

test('partial invalid symbols populate failedSymbols', async () => {
  const { body } = await call(scan, { symbols:'BBCA,BBRI,BADAAA,BADBBB', debug:'1' });
  assert.equal(body.ok, true);
  assert.equal(body.summary.scanned, 4);
  assert.ok(body.diagnostics.failedSymbols.length >= 2);
});

test('debug fault flags only work with debug=1', async () => {
  const withoutDebug = await call(scan, { symbols:'BBCA', forceProviderFail:'1' });
  const withDebug = await call(scan, { symbols:'BBCA', debug:'1', forceProviderFail:'1' });
  assert.equal(withoutDebug.body.summary.noData < 1, true);
  assert.equal(withDebug.body.summary.noData, 1);
});

test('health exposes scan and cache status', async () => {
  const { body } = await call(health);
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.equal(typeof body.serverTime, 'string');
  assert.equal(typeof body.session.status, 'string');
  assert.equal(typeof body.providers.statusSummary, 'string');
  assert.equal(typeof body.cache.status, 'string');
});

// ---------------------------------------------------------------------------
// alert endpoint tests
// ---------------------------------------------------------------------------

test('alert rejects non-POST', async () => {
  const { statusCode, body } = await call(alert, {});
  assert.equal(statusCode, 405);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'METHOD_NOT_ALLOWED');
});

test('alert returns 503 when NTFY_TOPIC not configured', async () => {
  const saved = process.env.NTFY_TOPIC;
  delete process.env.NTFY_TOPIC;
  // Re-require to pick up env change — use a fresh module load via cache bust.
  const mod = require('../api/alert');
  const { statusCode, body } = await callPost(mod, { symbol:'BBCA', action:'STRONG_BUY', score:85, confidence:80, price:9500, changePct:3.2, reasons:['Momentum positif'] });
  assert.equal(statusCode, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'NTFY_NOT_CONFIGURED');
  if (saved !== undefined) process.env.NTFY_TOPIC = saved;
});

test('alert rejects missing symbol field', async () => {
  const saved = process.env.NTFY_TOPIC;
  process.env.NTFY_TOPIC = 'test-topic';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok:true });
  const { statusCode, body } = await callPost(alert, { action:'STRONG_BUY' });
  assert.equal(statusCode, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'MISSING_FIELDS');
  globalThis.fetch = origFetch;
  if (saved !== undefined) process.env.NTFY_TOPIC = saved;
  else delete process.env.NTFY_TOPIC;
});

test('alert sends to ntfy and returns ok when configured', async () => {
  const saved = process.env.NTFY_TOPIC;
  process.env.NTFY_TOPIC = 'test-topic';
  let capturedUrl = null;
  let capturedTitle = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedTitle = opts.headers['Title'];
    return { ok:true };
  };
  const { statusCode, body } = await callPost(alert, {
    symbol:'BBCA', action:'STRONG_BUY', score:88, confidence:82,
    price:9600, changePct:3.5, reasons:['Momentum positif','Volume spike 2.8x']
  });
  assert.equal(statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sent, true);
  assert.ok(capturedUrl && capturedUrl.includes('test-topic'), 'should POST to ntfy topic URL');
  assert.ok(capturedTitle && capturedTitle.includes('BBCA'), 'title should include symbol');
  globalThis.fetch = origFetch;
  if (saved !== undefined) process.env.NTFY_TOPIC = saved;
  else delete process.env.NTFY_TOPIC;
});

// ---------------------------------------------------------------------------
// IDX flow enrichment test — scan should not break when idxFlow returns Map
// ---------------------------------------------------------------------------

test('scan handles idxFlow enrichment without breaking signals', async () => {
  const { body } = await call(scan, { symbols:'BBCA,BBRI', debug:'1' });
  assert.equal(body.ok, true);
  // diagnostics.provider should reflect the active provider (idx-api, yahoo, or with +idx-flow suffix)
  const p = body.diagnostics.provider || '';
  assert.ok(
    ['idx_api','yahoo','yahoo-finance','pending','idx_api+idx-flow','yahoo+idx-flow','yahoo-finance+idx-flow'].includes(p),
    `unexpected provider value: ${p}`
  );
  // All signals must still have required fields
  const allSigs = Object.values(body.recommendations).flat();
  for (const sig of allSigs) {
    assert.ok(sig.symbol, 'signal must have symbol');
    assert.ok(sig.action, 'signal must have action');
  }
});
