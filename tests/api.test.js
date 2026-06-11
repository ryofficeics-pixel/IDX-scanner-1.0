'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const scan = require('../api/scan');
const health = require('../api/health');

function call(handler, query = {}) {
  return new Promise((resolve, reject) => {
    const req = { method:'GET', query };
    const res = {
      headers:{},
      statusCode:200,
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode:this.statusCode, body }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
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
