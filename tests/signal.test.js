'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSignal } = require('../lib/engine/signalEngine');
const { generateBowSignal } = require('../lib/engine/bowEngine');
const { sessionContext } = require('../lib/market/idxSession');

function stock(overrides = {}) {
  return {
    symbol:'TEST',
    yahooSymbol:'TEST.JK',
    name:'Test Stock',
    lastPrice:1020,
    previousClose:1000,
    dayHigh:1030,
    dayLow:990,
    volume:20000000,
    avgVolume20:10000000,
    timestamp:new Date().toISOString(),
    source:'unit-test',
    ...overrides,
  };
}

function histories(now, overrides = {}) {
  return {
    now,
    daily:Array.from({ length:20 }, (_, i) => ({ high:950 + i * 3, close:940 + i * 3, volume:10000000 })),
    intraday:[{ close:1000, volume:1000000 }, { close:1010, volume:1000000 }, { close:1025, volume:1000000 }],
    ...overrides,
  };
}

function signalAt(iso, overrides = {}, market = { ihsgChangePct:0.2 }, historyOverrides = {}) {
  const now = new Date(iso);
  return generateSignal(stock({ timestamp:now.toISOString(), ...overrides }), market, sessionContext(now), histories(now, historyOverrides));
}

test('liquid strong momentum can become buy or strong buy', () => {
  const sig = signalAt('2026-06-11T02:30:00.000Z', {
    lastPrice:1040, previousClose:1000, volume:70000000, avgVolume20:10000000, dayHigh:1042, dayLow:995,
  });
  assert.ok(['BUY', 'STRONG_BUY'].includes(sig.action));
  assert.notEqual(sig.riskLevel, 'HIGH');
});

test('illiquid spike is rejected', () => {
  const sig = signalAt('2026-06-11T03:00:00.000Z', {
    lastPrice:1200, previousClose:1000, volume:50000, avgVolume20:100000, dayHigh:1200, dayLow:990,
  });
  assert.equal(sig.riskLevel, 'HIGH');
  assert.notEqual(sig.action, 'STRONG_BUY');
});

test('high volume fade becomes distribution proxy or risk', () => {
  const sig = signalAt('2026-06-11T07:00:00.000Z', {
    lastPrice:1005, previousClose:1000, volume:60000000, avgVolume20:10000000, dayHigh:1120, dayLow:995,
  });
  assert.ok(sig.category === 'DISTRIBUTION_PROXY' || sig.category === 'RISK' || sig.riskLevel === 'HIGH');
  assert.ok(!['BUY', 'STRONG_BUY'].includes(sig.action));
});

test('no volume avoids buy recommendation', () => {
  const sig = signalAt('2026-06-11T03:00:00.000Z', {
    volume:null, avgVolume20:null,
  });
  assert.ok(['AVOID', 'NO_DATA', 'HOLD'].includes(sig.action));
  assert.notEqual(sig.action, 'STRONG_BUY');
});

test('low data quality reduces confidence', () => {
  const sig = signalAt('2026-06-11T03:00:00.000Z', {
    lastPrice:-1, previousClose:0,
  });
  assert.equal(sig.action, 'NO_DATA');
  assert.ok(sig.confidence < 50);
});

test('outside market hour blocks direct morning and afternoon labels', () => {
  const sig = signalAt('2026-06-13T15:00:00.000Z', {
    lastPrice:1040, previousClose:1000, volume:70000000, avgVolume20:10000000, dayHigh:1042, dayLow:995,
  });
  assert.notEqual(sig.category, 'BELI_PAGI');
  assert.notEqual(sig.category, 'BELI_SORE');
});

test('stale provider timestamp blocks active buy', () => {
  const sig = signalAt('2026-06-11T03:00:00.000Z', {
    timestamp:'2026-06-11T02:25:00.000Z',
    lastPrice:1040, previousClose:1000, volume:70000000, avgVolume20:10000000, dayHigh:1042, dayLow:995,
  });
  assert.ok(sig.warnings.some((warning) => warning.includes('30 menit')));
  assert.ok(!['BUY', 'STRONG_BUY'].includes(sig.action));
  assert.ok(sig.indicators.freshnessScore < 55);
});

test('price below vwap blocks strong buy', () => {
  const sig = signalAt('2026-06-11T03:00:00.000Z', {
    lastPrice:1030, previousClose:1000, volume:70000000, avgVolume20:10000000, dayHigh:1042, dayLow:995,
  }, { ihsgChangePct:0.2 }, {
    intraday:[
      { close:1060, volume:3000000 },
      { close:1055, volume:3000000 },
      { close:1030, volume:1000000 },
    ],
  });
  assert.ok(sig.indicators.vwapDistancePct < 0);
  assert.notEqual(sig.action, 'STRONG_BUY');
});

test('wide intraday range raises risk and blocks strong buy', () => {
  const sig = signalAt('2026-06-11T03:00:00.000Z', {
    lastPrice:1040, previousClose:1000, volume:70000000, avgVolume20:10000000, dayHigh:1150, dayLow:930,
  });
  assert.ok(sig.warnings.includes('Range intraday terlalu lebar'));
  assert.notEqual(sig.action, 'STRONG_BUY');
});

function bowDaily({ pullback = 0.1, volumeDistribution = false } = {}) {
  const rows = [];
  for (let i = 0; i < 220; i += 1) {
    const base = 1000 + i * 3;
    rows.push({ open:base - 2, high:base + 8, low:base - 8, close:base, volume:12000000 });
  }
  const high = rows[rows.length - 16].close;
  const healthyPath = [0.99, 0.985, 0.995, 0.98, 0.975, 0.982, 0.968, 0.96, 0.967, 0.952, 0.945, 0.955, 0.94, 0.948, 1 - pullback];
  for (let i = rows.length - 15; i < rows.length; i += 1) {
    const step = i - (rows.length - 15);
    const progress = (step + 1) / 15;
    const close = high * (volumeDistribution ? (1 - pullback * progress) : healthyPath[step]);
    rows[i] = {
      open:close * (step % 2 ? 1.006 : 0.994),
      high:close * 1.015,
      low:close * 0.985,
      close,
      volume:volumeDistribution ? 24000000 : 8000000,
    };
  }
  rows[rows.length - 1].open = rows[rows.length - 1].close * 0.99;
  return rows;
}

test('buy on weakness accepts healthy pullback in long uptrend', () => {
  const daily = bowDaily();
  const last = daily[daily.length - 1].close;
  const bow = generateBowSignal(stock({
    lastPrice:last,
    previousClose:daily[daily.length - 2].close,
    volume:9000000,
    avgVolume20:10000000,
    dayHigh:last * 1.01,
    dayLow:last * 0.98,
    marketCap:5e12,
    trailingPE:12,
    priceToBook:1.7,
    epsTrailingTwelveMonths:80,
  }), { ihsgReturn3M:3 }, { daily });
  assert.ok(bow.score >= 70);
  assert.equal(bow.action, 'BOW_BUY');
  assert.equal(bow.trend, 'Uptrend');
});

test('buy on weakness rejects falling knife', () => {
  const daily = bowDaily({ pullback:0.38, volumeDistribution:true });
  const last = daily[daily.length - 1].close;
  const bow = generateBowSignal(stock({
    lastPrice:last,
    previousClose:daily[daily.length - 2].close,
    volume:24000000,
    avgVolume20:15000000,
    marketCap:5e12,
  }), { ihsgReturn3M:3 }, { daily });
  assert.equal(bow.category, 'Falling Knife');
  assert.equal(bow.verdict, 'Avoid');
  assert.notEqual(bow.action, 'BOW_BUY');
});
