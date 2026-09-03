import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnrichmentService } from '../src/enrichment.js';

const config = {
  detailSymbolLimit:2,
  symbolConcurrency:2,
  brokerPeriod:'LAST_7_DAYS',
  flowThresholdIdr:1_000_000_000,
};

function successfulApi(calls) {
  return {
    async getBrokerSummary({ symbol, period }) {
      calls.push(['broker', symbol, period]);
      return {
        symbol, from:'2026-08-27', to:'2026-09-03', buyers:[], sellers:[],
        bandarDetector:{ avg:{ accdist:'Big Acc', amount:2_000_000_000 } },
      };
    },
    async getQuote(symbol) {
      calls.push(['quote', symbol]);
      return { price:100, bestBid:{ price:99 }, bestOffer:{ price:101 } };
    },
    async getOrderbook(symbol) {
      calls.push(['orderbook', symbol]);
      return { bid:[{ price:99, volume:200 }], offer:[{ price:101, volume:100 }] };
    },
    async getKeystats(symbol) {
      calls.push(['keystats', symbol]);
      return { closure_fin_items_results:[{ fin_name_results:[
        { fitem_name:'Current PE Ratio (TTM)', fitem_value:'12.5' },
      ] }] };
    },
  };
}

test('fetches broker context for all symbols and detailed data only for the leading candidates', async () => {
  const calls = [];
  const enrich = createEnrichmentService(successfulApi(calls), config);
  const result = await enrich(['BBCA', 'BBRI', 'TLKM']);

  assert.deepEqual(result.detailedSymbols, ['BBCA', 'BBRI']);
  assert.deepEqual(calls.filter(([name]) => name === 'broker').map(([, symbol]) => symbol).sort(), ['BBCA', 'BBRI', 'TLKM']);
  assert.deepEqual(calls.filter(([name]) => name === 'quote').map(([, symbol]) => symbol).sort(), ['BBCA', 'BBRI']);
  assert.equal(calls.filter(([name]) => name === 'orderbook').length, 2);
  assert.equal(calls.filter(([name]) => name === 'keystats').length, 2);
  assert.equal(result.enrichments.BBCA.signal, 'ACCUMULATION');
  assert.equal(result.enrichments.BBCA.fundamentals.pe, 12.5);
  assert.equal(result.enrichments.TLKM.quote, undefined);
  assert.deepEqual(result.errors, []);
});

test('returns safe error codes and no false enrichment when every upstream call fails', async () => {
  const failure = Object.assign(new Error('refresh-token-secret-must-not-leak'), { kind:'auth', status:401 });
  const api = {
    getBrokerSummary:async () => { throw failure; },
    getQuote:async () => { throw failure; },
    getOrderbook:async () => { throw failure; },
    getKeystats:async () => { throw failure; },
  };
  const enrich = createEnrichmentService(api, { ...config, detailSymbolLimit:1 });
  const result = await enrich(['BBCA']);

  assert.deepEqual(result.enrichments, {});
  assert.deepEqual(result.errors, [
    { symbol:'BBCA', code:'broker:STOCKBIT_AUTH_FAILED' },
    { symbol:'BBCA', code:'quote:STOCKBIT_AUTH_FAILED' },
    { symbol:'BBCA', code:'orderbook:STOCKBIT_AUTH_FAILED' },
    { symbol:'BBCA', code:'keystats:STOCKBIT_AUTH_FAILED' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /refresh-token-secret/);
});

test('keeps useful broker data when an optional detailed call fails', async () => {
  const calls = [];
  const api = successfulApi(calls);
  api.getQuote = async () => { throw Object.assign(new Error('limited'), { status:429 }); };
  const enrich = createEnrichmentService(api, config);
  const result = await enrich(['BBCA']);

  assert.equal(result.enrichments.BBCA.signal, 'ACCUMULATION');
  assert.deepEqual(result.errors, [{ symbol:'BBCA', code:'quote:STOCKBIT_RATE_LIMITED' }]);
});

test('rejects an incomplete stockbit core adapter at startup', () => {
  assert.throws(() => createEnrichmentService({}, config), /getBrokerSummary/);
});
