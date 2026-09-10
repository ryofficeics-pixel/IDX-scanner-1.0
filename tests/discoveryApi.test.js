'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const scan = require('../api/scan');
const idxData = require('../lib/providers/idxDataProvider');
const idx = require('../lib/providers/idxProvider');
const idxApi = require('../lib/providers/idxApiProvider');
const yahoo = require('../lib/providers/yahooProvider');

const now = '2026-06-11T02:40:00Z';
const daily = Array.from({ length:80 }, (_, i) => ({ timestamp:new Date(Date.UTC(2026, 2, 1 + i)).toISOString(), open:999, high:1005, low:995, close:1000, volume:1e7 }));
const intraday = Array.from({ length:8 }, (_, i) => ({ timestamp:new Date(Date.UTC(2026, 5, 11, 2, i * 5)).toISOString(), open:1000 + i, high:1003 + i, low:999 + i, close:1002 + i, volume:1e6 }));
function call(query) {
  return new Promise((resolve, reject) => {
    const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { resolve(body); } };
    scan({ method:'GET', query:{ ...query, debug:'1', mockTime:now } }, response).catch(reject);
  });
}

async function providers(worker, failHistory = false) {
  const originals = [];
  const replace = (object, field, fn) => { originals.push([object, field, object[field]]); object[field] = fn; };
  let active = 0;
  let peak = 0;
  const fetched = new Set();
  replace(idxData, 'getBatchQuotes', async (symbols) => ({ quotes:Object.fromEntries(symbols.map((symbol) => [symbol, {
    symbol, lastPrice:1009, previousClose:1000, dayOpen:1000, dayHigh:1010, dayLow:999, volume:8e6, timestamp:now, source:'unit-test',
  }])), failedSymbols:[] }));
  replace(idx, 'getBatchStockSummary', async () => new Map());
  replace(idxData, 'getIHSG', async () => ({ lastPrice:7000, previousClose:6990, timestamp:now }));
  replace(idxApi, 'getStockQuote', async () => ({ lastPrice:7000, previousClose:6990, timestamp:now }));
  replace(idxApi, 'getDailyHistory', async () => daily);
  const history = (result) => async (symbol) => {
    fetched.add(symbol); active += 1; peak = Math.max(peak, active);
    try { await new Promise((resolve) => setTimeout(resolve, 2)); if (failHistory) throw new Error('EXPECTED_HISTORY_FAILURE'); return result; }
    finally { active -= 1; }
  };
  replace(yahoo, 'getDailyHistory', history(daily));
  replace(yahoo, 'getIntradayHistory', history(intraday));
  try { await worker({ fetched, peak:() => peak }); }
  finally { for (const [object, field, fn] of originals) object[field] = fn; }
}

test('API retains every recommendation collection, enriches bounded candidates, and attaches derived volume', async () => {
  await providers(async ({ fetched, peak }) => {
    const symbols = Array.from({ length:120 }, (_, i) => `S${i}`).join(',');
    const body = await call({ symbols });
    assert.equal(body.ok, true);
    assert.equal(body.summary.scanned, 120);
    const keys = ['buyOnWeakness', 'bowWatch', 'strongBuy', 'beliPagi', 'beliSore', 'topBuy', 'topGainers', 'accumulationProxy', 'distributionProxy', 'araCandidates', 'earlyMomentum', 'morningWatch', 'risk', 'hold', 'sell'];
    assert.deepEqual(Object.keys(body.recommendations).sort(), keys.sort());
    assert.equal(body.diagnostics.candidatePass1Count, 120);
    assert.equal(body.diagnostics.historyCandidateCount, 72);
    assert.equal(fetched.size, 72);
    assert.ok(peak() <= 32);
    assert.ok(Object.values(body.recommendations).flat().some((signal) => signal.avgVolume20 === 1e7));
    assert.equal(body.diagnostics.providerCoverage, 1);
  });
});

test('all history providers can fail without producing fake early candidates or failing the API', async () => {
  await providers(async () => {
    const body = await call({ symbols:'FAIL1,FAIL2' });
    assert.equal(body.ok, true);
    assert.equal(body.diagnostics.failedSymbols.length, 2);
    assert.equal(body.recommendations.earlyMomentum.length, 0);
    assert.equal(body.recommendations.topBuy.length, 0);
    assert.equal(body.recommendations.strongBuy.length, 0);
  }, true);
});

test('evening scan discovers a quiet setup even when official summary data is unavailable', async () => {
  await providers(async () => {
    const evening = require('../api/eveningScan');
    const body = await new Promise((resolve, reject) => {
      evening({ method:'GET', query:{ symbols:'EVEN1,EVEN2', debug:'1', mockTime:'2026-06-11T15:00:00Z' } }, {
        setHeader() {}, status() { return this; }, json:resolve,
      }).catch(reject);
    });
    assert.equal(body.ok, true);
    assert.equal(body.diagnostics.candidatePass1Count, 2);
    assert.ok(body.morningBoomPicks.length > 0);
    assert.ok(body.morningBoomPicks.every((signal) => signal.action === 'WATCH' || signal.action === 'BOW_BUY'));
    assert.ok(body.morningBoomPicks.filter((signal) => signal.action === 'WATCH').every((signal) => signal.verdict === 'Watchlist' && signal.preMarketPlan === null));
  });
});
