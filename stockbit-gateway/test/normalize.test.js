import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeNormalized,
  normalizeBrokerSummary,
  normalizeFundamentals,
  normalizeOrderbook,
  normalizeQuote,
} from '../src/normalize.js';

test('normalizes Stockbit broker detector output without changing signed seller values', () => {
  const result = normalizeBrokerSummary({
    symbol:'BBCA',
    from:'2026-08-27',
    to:'2026-09-03',
    buyers:[{ code:'YP', investorType:'Lokal', netLots:'12345', netValueIdr:'8.2e+10', avgPrice:'6700' }],
    sellers:[{ code:'AK', investorType:'Asing', netLots:'-9000', netValueIdr:'-6.1e+10', avgPrice:'6680' }],
    bandarDetector:{ avg:{ accdist:'Big Acc', amount:'8.390555e+10' } },
  }, { thresholdIdr:1_000_000_000, period:'LAST_7_DAYS' });

  assert.equal(result.signal, 'ACCUMULATION');
  assert.equal(result.sentiment, 'bullish');
  assert.equal(result.brokerSummary.netBuyValue, 83_905_550_000);
  assert.equal(result.brokerSummary.topBuyers[0].broker, 'YP');
  assert.equal(result.brokerSummary.topSellers[0].value, -61_000_000_000);
  assert.equal(result.brokerSummary.timestamp, '2026-09-03');
  assert.match(result.summary, /LAST_7_DAYS/);
});

test('uses a neutral band for detector amounts below the configured threshold', () => {
  const result = normalizeBrokerSummary({
    symbol:'BBRI', buyers:[], sellers:[],
    bandarDetector:{ avg:{ accdist:'Normal Acc', amount:500_000_000 } },
  }, { thresholdIdr:1_000_000_000 });
  assert.equal(result.signal, 'NEUTRAL');
  assert.equal(result.sentiment, 'neutral');
});

test('normalizes quote and compares the same top-five orderbook depth on both sides', () => {
  const quote = { price:'6700', bestBid:{ price:'6690' }, bestOffer:{ price:'6705' } };
  const book = {
    bid:[
      { price:{ raw:6690 }, volume:{ raw:100 } },
      { price:{ raw:6685 }, volume:{ raw:200 } },
      { price:{ raw:6680 }, volume:{ raw:300 } },
      { price:{ raw:6675 }, volume:{ raw:400 } },
      { price:{ raw:6670 }, volume:{ raw:500 } },
      { price:{ raw:6665 }, volume:{ raw:10000 } },
    ],
    offer:[
      { price:{ raw:6705 }, volume:{ raw:100 } },
      { price:{ raw:6710 }, volume:{ raw:100 } },
      { price:{ raw:6715 }, volume:{ raw:100 } },
      { price:{ raw:6720 }, volume:{ raw:100 } },
      { price:{ raw:6725 }, volume:{ raw:100 } },
    ],
  };

  assert.deepEqual(normalizeQuote(quote), { quote:{ price:6700, bid:6690, offer:6705 } });
  assert.deepEqual(normalizeOrderbook(book, quote), {
    orderbook:{ imbalance:50, bestBid:6690, bestOffer:6705, bidDepth:1500, offerDepth:500 },
  });
});

test('normalizes both Stockbit keystats row shapes and drops empty metric objects', () => {
  const fundamentals = normalizeFundamentals({ closure_fin_items_results:[{ fin_name_results:[
    { fitem_name:'Current PE Ratio (TTM)', fitem_value:'8.00' },
    { fitem_name:'Current Price to Book Value', fitem_value:'1,390.55' },
    { fitem:{ name:'Return on Equity (TTM)', value:'17.30%' } },
    { fitem:{ name:'Debt to Equity Ratio (Quarter)', value:'0.45' } },
  ] }] });
  assert.deepEqual(fundamentals, { fundamentals:{ pe:8, pbv:1390.55, roe:17.3, der:0.45 } });
  assert.deepEqual(normalizeFundamentals({}), {});
  assert.deepEqual(normalizeBrokerSummary({}), {});
});

test('merges only normalized objects', () => {
  assert.deepEqual(mergeNormalized(
    { quote:{ price:100 } },
    { quote:{ bid:99 }, signal:'ACCUMULATION' },
    null,
  ), { quote:{ price:100, bid:99 }, signal:'ACCUMULATION' });
});
