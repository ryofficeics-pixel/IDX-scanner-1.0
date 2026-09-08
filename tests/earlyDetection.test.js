'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { generateSignal, signalPhase } = require('../lib/engine/signalEngine');
const { setupFeatures } = require('../lib/engine/setupEngine');
const { triggerFeatures } = require('../lib/engine/triggerEngine');
const { selectHistoryCandidates } = require('../lib/engine/candidateDiscovery');
const { entryEfficiency } = require('../lib/engine/entryEfficiency');
const { completedDaily, partitionIntraday, BAR_MS } = require('../lib/market/historyContext');
const { sessionContext } = require('../lib/market/idxSession');
const replay = require('../scripts/intradayBacktest');
const state = require('../lib/store/candidateState');

function dailyHistory() {
  return Array.from({ length:65 }, (_, i) => {
    const close = i < 60 ? 970 + i * 0.5 : 1000 + (i - 60) * 0.1;
    return { date:new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10), open:close - 1,
      high:close + (i < 60 ? 20 : 3), low:close - (i < 60 ? 20 : 3), close, volume:i < 60 ? 1e7 : 5e6 };
  });
}
function bars(prices = [1000, 998, 999, 1000, 1002, 1005, 1010, 1014, 1020, 1040, 1060, 1120]) {
  return prices.map((close, i) => ({ timestamp:new Date(Date.UTC(2026, 5, 11, 2, i * 5)).toISOString(),
    open:i ? prices[i - 1] : close, high:Math.max(close, i ? prices[i - 1] : close) + 1,
    low:Math.min(close, i ? prices[i - 1] : close) - 1, close, volume:i < 4 ? 3e5 : (i - 2) * 4e5 }));
}
function signalAt(index = 6, overrides = {}) {
  const intraday = bars().slice(0, index + 1);
  const last = intraday.at(-1);
  const now = new Date(new Date(last.timestamp).getTime() + BAR_MS);
  const stock = { symbol:'TEST', lastPrice:last.close, previousClose:1000, dayOpen:1000,
    dayHigh:Math.max(...intraday.map((bar) => bar.high)), dayLow:Math.min(...intraday.map((bar) => bar.low)),
    volume:intraday.reduce((sum, bar) => sum + bar.volume, 0), avgVolume20:1e7, timestamp:now.toISOString(), ...overrides };
  return generateSignal(stock, { ihsgChangePct:0.2 }, sessionContext(now), { now, daily:dailyHistory(), intraday });
}

test('compressed tight base near resistance scores before breakout', () => {
  const daily = dailyHistory();
  const setup = setupFeatures({ lastPrice:1001, volume:1e6 }, daily);
  assert.ok(setup.volatilityCompressionScore > 60);
  assert.ok(setup.priceTightnessScore > 80);
  assert.ok(setup.breakoutProximityScore > 70);
  assert.ok(setup.setupScore > 55);
  assert.ok(setup.distanceTo20dHighPct > 0);
});

test('quiet accumulation uses real positive flow and missing flow stays neutral', () => {
  const stock = { lastPrice:1001, volume:1e6 };
  const quiet = setupFeatures(stock, dailyHistory());
  const flow = setupFeatures({ ...stock, netBuy:2e8 }, dailyHistory());
  assert.ok(quiet.volumeDryUpRatio < 1);
  assert.equal(quiet.flowScore, 50);
  assert.ok(flow.flowScore > quiet.flowScore);
});

test('relative strength uses aligned IHSG observations, unavailable benchmark stays unknown', () => {
  const daily = dailyHistory();
  const market = daily.map((row) => ({ ...row, close:1000 }));
  const improved = daily.map((row, i) => ({ ...row, close:i > 59 ? row.close + (i - 59) * 2 : row.close }));
  const old = setupFeatures({ lastPrice:1000 }, daily, market);
  const next = setupFeatures({ lastPrice:1010 }, improved, market);
  assert.ok(next.relativeStrengthAcceleration > old.relativeStrengthAcceleration);
  assert.equal(setupFeatures({}, daily).relativeStrength5d, null);
});

test('price and volume acceleration identify an early change in demand', () => {
  const signal = signalAt(6);
  assert.ok(signal.changePct < 2);
  assert.ok(signal.indicators.priceAcceleration > 0);
  assert.ok(signal.indicators.volumeAcceleration > 1);
});

test('a steady large move does not beat accelerating early prices by magnitude alone', () => {
  const early = triggerFeatures({}, bars([1000, 1000, 1000, 1001, 1005, 1010, 1018]), { status:'MORNING' });
  const late = triggerFeatures({}, bars([1080, 1081, 1082, 1083, 1084, 1085, 1086]), { status:'MORNING' });
  assert.ok(early.priceAcceleration > late.priceAcceleration);
  assert.ok(early.triggerScore > late.triggerScore);
});

test('VWAP reclaim, rejection, bounce and micro breakout are explicit transitions', () => {
  const reclaim = triggerFeatures({}, bars([1005, 1002, 1000, 999, 998, 997, 1008]), { status:'MORNING' });
  assert.equal(reclaim.vwapReclaim, true);
  assert.equal(reclaim.microBreakout, true);
  const rejection = triggerFeatures({}, bars([1000, 1002, 1004, 1006, 1003, 995]), { status:'MORNING' });
  assert.equal(rejection.vwapRejection, true);
  const bounceBars = bars([1000, 1000, 1000, 1000, 1002]);
  bounceBars.at(-1).low = 999;
  assert.equal(triggerFeatures({}, bounceBars, { status:'MORNING' }).vwapBounce, true);
});

test('15 and 30 minute ranges require completed clock windows and cannot use future bars', () => {
  const all = bars();
  const at0910 = partitionIntraday(all, new Date('2026-06-11T02:10:00Z')).current;
  assert.equal(triggerFeatures({}, at0910, { status:'MORNING' }).openingRange15.complete, false);
  const at0915 = partitionIntraday(all, new Date('2026-06-11T02:15:00Z')).current;
  const fifteen = triggerFeatures({}, at0915, { status:'MORNING' });
  assert.equal(fifteen.openingRange15.complete, true);
  assert.equal(fifteen.openingRange30.complete, false);
  const thirty = triggerFeatures({}, all.slice(0, 6), { status:'MORNING' });
  assert.equal(thirty.openingRange30.complete, true);
  assert.equal(triggerFeatures({}, all.slice(0, 7), { status:'MORNING' }).openingRangeBreakout, true);
  assert.equal(triggerFeatures({}, all.slice(0, 7), { status:'AFTERNOON' }).openingRangeBreakout, false);
  assert.equal(triggerFeatures({}, all.slice(1, 7), { status:'MORNING' }).openingRange30.complete, false);
});

test('same-time volume compares clock slots and requires three prior sessions', () => {
  const current = bars().slice(0, 6);
  const baselines = [8, 9, 10].map((date) => current.map((bar) => ({ ...bar, timestamp:bar.timestamp.replace('11T', `${String(date).padStart(2, '0')}T`), volume:bar.volume / 2 })));
  const actual = triggerFeatures({}, current, { status:'MORNING' }, baselines);
  assert.equal(actual.timeOfDayVolumeRatio, 2);
  assert.equal(triggerFeatures({}, current, { status:'MORNING' }, baselines.slice(0, 2)).timeOfDayVolumeRatio, null);
});

test('same-clock volume cache matches direct sums and invalidates revised historical volume', () => {
  const current = bars();
  const days = [8, 9, 10].map((d) => current.map((bar) => ({ ...bar,
    timestamp:bar.timestamp.replace('11T', `${String(d).padStart(2, '0')}T`), volume:bar.volume / 2 })));
  for (let count = 3; count <= current.length; count += 1) {
    const signal = triggerFeatures({}, current.slice(0, count), { status:'MORNING' }, days);
    assert.equal(signal.timeOfDayVolumeRatio, 2);
  }
  days[0][3].volume *= 10;
  const changed = triggerFeatures({}, current, { status:'MORNING' }, days);
  const expected = current.reduce((sum, bar) => sum + bar.volume, 0)
    / (days.reduce((sum, day) => sum + day.reduce((subtotal, bar) => subtotal + bar.volume, 0), 0) / 3);
  assert.equal(changed.timeOfDayVolumeRatio, expected);
  assert.notEqual(changed.timeOfDayVolumeRatio, 2);
});

test('entry efficiency measures actual MA distance and marks extension', () => {
  const base = { changePct:2, atrPct:2, sma5:1000, vwapDistancePct:1, araProgressPct:8 };
  const early = entryEfficiency(base, { breakoutProximityScore:80 }, { lastPrice:1020, dayOpen:1000 });
  const late = entryEfficiency({ ...base, changePct:14, vwapDistancePct:8, araProgressPct:80 }, { breakoutProximityScore:20 }, { lastPrice:1140, dayOpen:1000 });
  assert.ok(Math.abs(early.movingAverageExtensionPct - 2) < 1e-10);
  assert.ok(late.chasePenalty > early.chasePenalty);
  assert.equal(late.extended, true);
});

test('setup, armed, trigger, confirmation and failure transitions retain distinct states', () => {
  const ind = { setupHistoryAvailable:true, setupScore:55, triggerScore:35, confirmationScore:40 };
  assert.equal(signalPhase(ind), 'SETUP');
  assert.equal(signalPhase({ ...ind, setupScore:65 }), 'ARMED');
  assert.equal(signalPhase({ ...ind, setupScore:65, triggerScore:60 }), 'TRIGGERED');
  assert.equal(signalPhase({ ...ind, setupScore:65, triggerScore:75, confirmationScore:80 }), 'CONFIRMED');
  assert.equal(signalPhase({ ...ind, failedBreakout:true }), 'FAILED');
});

test('failed breakout removes an actionable trigger', () => {
  const result = triggerFeatures({}, bars([1000, 1000, 1000, 1000, 1005, 998]), { status:'MORNING' });
  assert.equal(result.failedBreakout, true);
  assert.ok(result.falseBreakoutPenalty >= 35);
});

test('stale and illiquid quotes never become meaningful detections', () => {
  assert.equal(replay.isMeaningful(signalAt(6, { volume:100 })), false);
  assert.equal(replay.isMeaningful(signalAt(6, { timestamp:'2026-06-10T02:00:00Z' })), false);
  assert.equal(replay.isMeaningful({ ...signalAt(6), action:'AVOID', signalPhase:'ARMED' }), false);
});

test('fetch-only timestamps need completed candles and never imply verified market freshness', () => {
  const actual = signalAt(6, { timestampSource:'fetch', lastPrice:1100 });
  assert.equal(actual.lastPrice, 1010);
  assert.ok(actual.source.endsWith('+5m-candles'));
  const now = new Date('2026-06-11T02:35:00Z');
  const missing = generateSignal({ symbol:'FETCH', lastPrice:1100, previousClose:1000, volume:1e7,
    timestamp:now.toISOString(), timestampSource:'fetch' }, {}, sessionContext(now), { now, daily:dailyHistory() });
  assert.equal(missing.riskLevel, 'HIGH');
  assert.ok(!replay.isMeaningful(missing));
});

test('provider budget skips new work after expiry and bounds a stalled provider', async () => {
  const { providerBudget } = require('../lib/utils/async');
  const bounded = providerBudget(10);
  await assert.rejects(bounded('STALLED', 20, () => new Promise(() => {})), /TIMEOUT/);
  let invoked = false;
  await assert.rejects(bounded('LATE', 10, async () => { invoked = true; }), /BUDGET_EXHAUSTED/);
  assert.equal(invoked, false);
});

test('daily context admits the current session only after the conservative closing cutoff', () => {
  const rows = [{ date:'2026-06-11', close:100 }, { date:'2026-06-12', close:200 }];
  assert.equal(completedDaily(rows, new Date('2026-06-11T03:00:00Z')).length, 0);
  assert.equal(completedDaily(rows, new Date('2026-06-11T10:00:00Z')).length, 1);
});

test('invalid history rows and future quote timestamps cannot create a fresh buy', () => {
  assert.deepEqual(completedDaily([null, { close:100, date:'invalid' }]), []);
  assert.deepEqual(partitionIntraday([null, { timestamp:'invalid' }]).current, []);
  assert.equal(signalAt(6, { timestamp:'2027-01-01T00:00:00Z' }).riskLevel, 'HIGH');
  const { inMorningBuyWindow, inAfternoonBuyWindow } = require('../lib/market/idxSession');
  assert.equal(inMorningBuyWindow(new Date('2026-06-13T02:30:00Z')), false);
  assert.equal(inAfternoonBuyWindow(new Date('2026-06-13T08:00:00Z')), false);
});

test('foreign-flow accumulation excludes future and expired data and normalizes numeric values', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  let writes = 0;
  const rows = [
    { date:'2026-06-12', netBuy:999 }, { date:'2026-06-11', netBuy:'20' },
    { date:'2026-06-10', netBuy:10 }, { date:'2026-05-01', netBuy:500 },
  ];
  class Redis { async get() { return rows; } async set() { writes += 1; } }
  const context = { module:{ exports:{} }, process:{ env:{ REDIS_URL:'https://unit.invalid', REDIS_TOKEN:'unit-test' } },
    require:(name) => name === '@upstash/redis' ? { Redis } : require('../lib/market/historyContext') };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/store/foreignFlowStore'), 'utf8'), context);
  const flow = context.module.exports;
  const result = await flow.getCumulative3d('TEST', new Date('2026-06-11T10:00:00Z'));
  assert.equal(result.cumulative, 30);
  assert.equal(result.count, 2);
  await flow.record('TEST', 1, 1, 0);
  await flow.record('TEST', 1, 1, 0, '2026-02-31');
  assert.equal(writes, 0);
});

test('history selection includes quiet pre-move names independent of current gainer ranking', () => {
  const quotes = Array.from({ length:120 }, (_, i) => ({ symbol:`S${i}`, lastPrice:1150, previousClose:1000, dayHigh:1160, dayLow:990, volume:1e6 }));
  quotes.push({ symbol:'QUIET', lastPrice:1001, previousClose:1000, dayHigh:1003, dayLow:999, volume:8e5 });
  const selected = selectHistoryCandidates(quotes, [], 30);
  assert.ok(selected.some((row) => row.symbol === 'QUIET'));
  assert.equal(selected.length, 30);
  assert.equal(new Set(selected.map((row) => row.symbol)).size, 30);
  assert.deepEqual(selectHistoryCandidates(quotes, [], 0), []);
});

test('mutating all future prices, volumes and daily rows cannot alter any signal at T', () => {
  const today = bars();
  const groups = [['2026-06-11', today]];
  const options = { daily:dailyHistory(), ihsgDaily:dailyHistory() };
  const before = replay.snapshotAt('TEST', groups, 0, 6, options);
  const changed = today.map((bar, i) => i <= 6 ? bar : { ...bar, open:100, high:999999, low:1, close:900000, volume:1e15 });
  const injected = [{ date:'2026-06-11', high:999999, low:1, close:999999, volume:1e15 }, { date:'2026-06-12', close:1, volume:1 }];
  const after = replay.snapshotAt('TEST', [['2026-06-11', changed]], 0, 6, { daily:[...options.daily, ...injected], ihsgDaily:[...options.ihsgDaily, ...injected] });
  assert.deepEqual(after.stock, before.stock);
  assert.deepEqual(after.signal, before.signal);
  assert.deepEqual(completedDaily([...options.daily, ...injected], before.now), options.daily);
});

test('forming candle cannot change a live signal before its close', () => {
  const now = new Date('2026-06-11T02:30:00Z');
  const all = bars();
  const first = partitionIntraday(all, now);
  const altered = all.map((bar, i) => i < 6 ? bar : { ...bar, high:999999, close:999999, volume:1e15 });
  assert.deepEqual(partitionIntraday(altered, now), first);
});

test('runner is surfaced before its major expansion', () => {
  const all = bars();
  const snapshots = replay.replayDay('TEST', [['2026-06-11', all]], 0, { daily:dailyHistory() });
  const first = snapshots.find(({ signal }) => replay.isMeaningful(signal));
  assert.ok(first, JSON.stringify(snapshots.map(({ signal }) => [signal.score, signal.signalPhase, signal.category])));
  assert.ok(first.signal.changePct < 3);
  assert.ok(first.index < all.length - 3);
});

test('target and stop in one bar report conservative and optimistic bounds', () => {
  const result = replay.evaluateExecution([{ open:100, high:110, low:90, close:102 }], 100, 'high');
  assert.equal(result.ambiguous, true);
  assert.equal(result.conservative, false);
  assert.equal(result.optimistic, true);
  assert.equal(result.targetHit, false);
  const daily = require('../scripts/backtest2y').swingExit(100, [{ open:100, high:110, low:90, close:102 }]);
  assert.equal(daily.win, false);
  assert.equal(daily.ambiguous, true);
});

test('entry uses next open, gaps stop conservatively, and expiry is not target attainment', () => {
  const next = replay.evaluateExecution([{ open:110, high:111, low:109, close:110.5 }], 100, 'low');
  assert.ok(next.entry > 110);
  const expiry = replay.evaluateExecution([{ open:100, high:101, low:100, close:101 }], 100, 'high');
  assert.equal(expiry.targetHit, false);
  const gap = replay.evaluateExecution([{ open:100, high:101, low:99, close:100 }, { open:90, high:91, low:89, close:90 }], 100, 'high');
  assert.equal(gap.outcome, 'stop-gap');
  assert.ok(gap.conservativeReturnPct < -10);
});

test('walk-forward dates are ordered and mutually exclusive', () => {
  const splits = replay.chronologicalSplits(Array.from({ length:10 }, (_, i) => ({ date:`2026-06-${String(i + 1).padStart(2, '0')}` })));
  assert.equal(splits.train.size, 6);
  assert.ok([...splits.train].at(-1) < [...splits.validation][0]);
  assert.ok([...splits.validation].at(-1) < [...splits.test][0]);
});

test('optional setup state survives separate symbol batches and expires', async () => {
  const a = signalAt(6);
  const now = new Date('2026-06-11T03:00:00Z');
  await state.save([a], now);
  await state.save([{ ...a, symbol:'OTHER' }], now);
  assert.equal((await state.read(['TEST', 'OTHER'], now)).length, 2);
  assert.equal((await state.read(['TEST'], new Date('2026-06-15T03:00:00Z'))).length, 0);
});

test('public UI differs from baseline only by the requested v2.2 label', () => {
  const baseline = execFileSync('git', ['show', `${replay.BASELINE_REF}:public/index.html`], { encoding:'utf8' });
  const expected = baseline.replace('IDX Flow Scanner v2.0', 'IDX Flow Scanner v2.2').replace('SCANNER v2.0', 'SCANNER v2.2');
  assert.equal(require('node:fs').readFileSync('public/index.html', 'utf8').replaceAll('\r\n', '\n'), expected);
  const oldSymbols = execFileSync('git', ['rev-parse', `${replay.BASELINE_REF}:public/idx-symbols.js`], { encoding:'utf8' }).trim();
  assert.equal(execFileSync('git', ['hash-object', 'public/idx-symbols.js'], { encoding:'utf8' }).trim(), oldSymbols);
});

test('pipeline replay applies production history budgets without future selection leakage', () => {
  const prepared = Object.fromEntries(Array.from({ length:90 }, (_, i) => [`P${i}`, {
    daily:dailyHistory(), groups:[['2026-06-11', bars().slice(0, 3)]],
  }]));
  const dates = new Set(['2026-06-11']);
  const revised = replay.pipelineSelection(prepared, dates, { discovery:'revised' });
  const old = replay.pipelineSelection(prepared, dates, { discovery:'baseline' });
  const at = '2026-06-11T02:10:00.000Z';
  assert.equal(revised.get(at).size, 72);
  assert.ok(old.get(at).size <= 40);
  for (const data of Object.values(prepared)) data.groups[0][1][2].volume *= 100;
  const mutated = replay.pipelineSelection(prepared, dates, { discovery:'revised' });
  assert.deepEqual([...mutated.get(at)], [...revised.get(at)]);
});

test('extended momentum remains separate from fresh entry and ARA scores are finite', () => {
  const signal = signalAt(11);
  assert.equal(signal.signalPhase, 'EXTENDED');
  assert.ok(!['BUY', 'STRONG_BUY'].includes(signal.action));
  assert.ok(Number.isFinite(signal.araSetupScore));
  assert.ok(Number.isFinite(signal.araContinuationScore));
  assert.equal(signal.araPhase, 'CONTINUATION');
});

test('new BOW patterns remain watch-only until observed intraday recovery confirms them', () => {
  const { generateBowSignal } = require('../lib/engine/bowEngine');
  const daily = Array.from({ length:80 }, (_, i) => {
    const close = i >= 60 ? 1100 : 1000;
    return { close, open:close, high:close * 1.03, low:close * 0.99, volume:1e7 };
  });
  const stock = { symbol:'PULL', lastPrice:1090, previousClose:1100, dayHigh:1100, dayLow:1070, volume:1e7, avgVolume20:1e7 };
  const now = new Date('2026-06-11T02:35:00Z');
  const watch = generateBowSignal(stock, {}, { daily, now });
  assert.ok(watch.patterns.some((pattern) => pattern.name === 'MA20_PULLBACK'));
  assert.equal(watch.action, 'WATCH');
  assert.equal(watch.preMarketPlan, null);
  const recovered = generateBowSignal({ ...stock, lastPrice:1105, dayHigh:1106, timestamp:now.toISOString() }, {}, {
    daily, now, intraday:bars([1080, 1078, 1076, 1075, 1076, 1080, 1105]),
  });
  assert.equal(recovered.patternConfirmed, true);
  assert.equal(recovered.action, 'BOW_BUY');
  assert.equal(recovered.entry.stopLoss, Math.round(recovered.patterns[0].invalidation));
  for (const timestamp of [null, 'invalid', '2026-06-10T02:35:00Z', '2026-06-11T03:35:00Z']) {
    const unverified = generateBowSignal({ ...stock, lastPrice:1105, dayHigh:1106, timestamp }, {}, {
      daily, now, intraday:bars([1080, 1078, 1076, 1075, 1076, 1080, 1105]),
    });
    assert.equal(unverified.action, 'WATCH');
    assert.equal(unverified.quoteVerified, false);
    assert.equal(unverified.preMarketPlan, null);
  }
});

test('production and replay exclude lunch-boundary and closing-auction bars identically', () => {
  const { partitionIntraday } = require('../lib/market/historyContext');
  for (const date of ['2026-06-11', '2026-06-12']) {
    const rows = ['09:00', '11:25', '11:30', '11:55', '12:00', '13:30', '14:00', '15:45', '15:50', '16:00'].map((clock) => ({
      timestamp:new Date(`${date}T${clock}:00+07:00`).toISOString(), open:100, high:101, low:99, close:100, volume:100,
    }));
    const live = partitionIntraday(rows, new Date(`${date}T17:00:00+07:00`)).current;
    const replayRows = replay.groupByDay(rows)[0][1];
    assert.deepEqual(live, replayRows);
  }
});

module.exports = { bars, dailyHistory, signalAt };
