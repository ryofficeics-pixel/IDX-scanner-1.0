'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { generateSignal } = require('../lib/engine/signalEngine');
const { sessionContext } = require('../lib/market/idxSession');
const { BAR_MS, number, dayKey, minuteOfDay, validBar, completedDaily } = require('../lib/market/historyContext');
const config = require('../lib/config/signalConfig');
const { selectHistoryCandidates } = require('../lib/engine/candidateDiscovery');

const BASELINE_REF = '7ed0b7d97e0f6401d065ac857834e4e7e67aeb2a';
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (a, b) => b > 0 ? (a / b - 1) * 100 : null;
const ratio = (a, b) => b ? a / b : null;

function baselineEngine(entry = 'lib/engine/signalEngine.js', exported = 'generateSignal') {
  const root = path.resolve(__dirname, '..');
  const loaded = new Map();
  function load(relative) {
    if (loaded.has(relative)) return loaded.get(relative).exports;
    const filename = path.join(root, relative);
    const source = execFileSync('git', ['show', `${BASELINE_REF}:${relative.replaceAll('\\', '/')}`], { cwd:root, encoding:'utf8' });
    const module = { exports:{} };
    loaded.set(relative, module);
    const localRequire = (name) => name.startsWith('.')
      ? load(path.relative(root, path.resolve(path.dirname(filename), name.endsWith('.js') ? name : `${name}.js`)))
      : createRequire(filename)(name);
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename:`baseline:${relative}` })(localRequire, module, module.exports);
    return module.exports;
  }
  return load(entry)[exported];
}

function groupByDay(rows) {
  const groups = new Map();
  const seen = new Set();
  for (const bar of rows) {
    if (!validBar(bar) || seen.has(bar.timestamp)) continue;
    seen.add(bar.timestamp);
    const session = sessionContext(new Date(bar.timestamp));
    if (!['MORNING', 'AFTERNOON', 'PRE_CLOSE'].includes(session.status)) continue;
    const endSession = sessionContext(new Date(new Date(bar.timestamp).getTime() + BAR_MS - 1));
    if (!['MORNING', 'AFTERNOON', 'PRE_CLOSE'].includes(endSession.status)) continue;
    const key = dayKey(bar.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, bars]) => [date, bars.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))]);
}

function dailyFromIntraday(groups, endExclusive) {
  return groups.slice(0, endExclusive).map(([date, bars]) => ({ date, open:bars[0].open,
    high:Math.max(...bars.map((bar) => bar.high)), low:Math.min(...bars.map((bar) => bar.low)),
    close:bars.at(-1).close, volume:bars.reduce((sum, bar) => sum + bar.volume, 0) }));
}

function liquidityBucket(tradedValue) {
  const bounds = config.backtest.liquidityValue;
  return tradedValue >= bounds.high ? 'high' : tradedValue >= bounds.medium ? 'medium' : 'low';
}

function evaluateExecution(futureBars, signalPrice, bucket, options = {}) {
  const settings = { ...config.backtest, ...options };
  const bars = futureBars.filter((bar) => ['open', 'high', 'low', 'close'].every((key) => number(bar[key]) > 0));
  if (!bars.length) return { conservative:null, optimistic:null, conservativeReturnPct:null, optimisticReturnPct:null, outcome:'no-fill', ambiguous:false, targetHit:false };
  const slip = settings.slippagePct[bucket] / 100;
  // Signal is known at bar close. First executable price is the next bar's open.
  const entry = bars[0].open * (1 + slip);
  const cost = entry * (1 + settings.buyFeePct / 100);
  const target = entry * (1 + settings.targetPct / 100);
  const stop = entry * (1 - settings.stopPct / 100);
  const net = (price) => pct(price * (1 - slip) * (1 - settings.sellFeePct / 100), cost);
  let outcome = 'expiry';
  let exitLow = bars.at(-1).close;
  let exitHigh = exitLow;
  let ambiguous = false;
  let exitIndex = bars.length - 1;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (i > 0 && bar.open <= stop) { outcome = 'stop-gap'; exitLow = exitHigh = bar.open; exitIndex = i; break; }
    if (i > 0 && bar.open >= target) { outcome = 'target-gap'; exitLow = exitHigh = bar.open; exitIndex = i; break; }
    const hitsTarget = bar.high >= target;
    const hitsStop = bar.low <= stop;
    if (hitsTarget && hitsStop) { outcome = 'ambiguous'; ambiguous = true; exitLow = stop; exitHigh = target; exitIndex = i; break; }
    if (hitsStop) { outcome = 'stop'; exitLow = exitHigh = stop; exitIndex = i; break; }
    if (hitsTarget) { outcome = 'target'; exitLow = exitHigh = target; exitIndex = i; break; }
  }
  return { entry, cost, target, stop, signalPrice, outcome, exitIndex, ambiguous,
    conservative:net(exitLow) > 0, optimistic:net(exitHigh) > 0,
    conservativeReturnPct:net(exitLow), optimisticReturnPct:net(exitHigh),
    targetHit:outcome.startsWith('target'), targetHitOptimistic:outcome.startsWith('target') || ambiguous };
}

function isMeaningful(signal) {
  return signal.dataQuality >= 60 && signal.riskLevel !== 'HIGH' && !['NO_DATA', 'SELL', 'AVOID'].includes(signal.action)
    && (['BUY', 'STRONG_BUY', 'HIGH_CONFIDENCE_BUY'].includes(signal.action)
      || ['EARLY_MOMENTUM', 'ARA_CANDIDATE', 'MORNING_WATCH'].includes(signal.category));
}

function snapshotAt(symbol, dayGroups, dayIndex, barIndex, options = {}) {
  const visible = dayGroups[dayIndex][1].slice(0, barIndex + 1);
  const bar = visible.at(-1);
  const now = new Date(new Date(bar.timestamp).getTime() + BAR_MS);
  const daily = completedDaily(options.daily || dailyFromIntraday(dayGroups, dayIndex), now);
  const previousClose = daily.at(-1)?.close;
  if (!(previousClose > 0)) return null;
  const volume = visible.reduce((sum, row) => sum + row.volume, 0);
  const stock = { symbol, yahooSymbol:`${symbol}.JK`, name:symbol, lastPrice:bar.close, previousClose,
    dayOpen:visible[0].open, dayHigh:Math.max(...visible.map((row) => row.high)), dayLow:Math.min(...visible.map((row) => row.low)),
    volume, avgVolume20:mean(daily.slice(-20).map((row) => number(row.volume)).filter((value) => value > 0)),
    changePct:pct(bar.close, previousClose), timestamp:now.toISOString(), source:'yahoo-intraday-replay' };
  const marketDaily = completedDaily(options.ihsgDaily || [], now);
  const marketVisible = (options.ihsgIntraday || []).filter((row) => dayKey(row.timestamp) === dayKey(now) && new Date(row.timestamp).getTime() + BAR_MS <= now.getTime());
  const market = { ihsgChangePct:marketVisible.length && marketDaily.length ? pct(marketVisible.at(-1).close, marketDaily.at(-1).close) : null };
  const histories = { now, daily, intraday:visible, ihsgDaily:marketDaily,
    intradayBaselines:dayGroups.slice(Math.max(0, dayIndex - 10), dayIndex).map(([, bars]) => bars), previousState:options.previousState };
  const session = sessionContext(now);
  const signal = (options.engine || generateSignal)(stock, market, session, histories);
  return { index:barIndex, bar, stock, market, session, histories, signal, now };
}

function replayDay(symbol, dayGroups, dayIndex, options = {}) {
  return dayGroups[dayIndex][1].map((_, index) => snapshotAt(symbol, dayGroups, dayIndex, index, options)).filter(Boolean);
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  return sorted[lower] + (position - lower) * ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]);
}

function eventMetrics(symbol, date, bars, previousClose, first) {
  const future = bars.slice(first.index + 1);
  const signalPrice = first.signal.lastPrice;
  const high = Math.max(...bars.map((bar) => bar.high));
  const futureHigh = future.length ? Math.max(...future.map((bar) => bar.high)) : signalPrice;
  const futureLow = future.length ? Math.min(...future.map((bar) => bar.low)) : signalPrice;
  const totalMove = high - previousClose;
  const milliseconds = new Date(first.bar.timestamp).getTime() + BAR_MS;
  const lead = (row) => row ? Math.max(0, (new Date(row.timestamp).getTime() + BAR_MS - milliseconds) / 60000) : null;
  const highBar = bars.find((bar) => bar.high === high);
  const ind = first.signal.indicators;
  const bucket = liquidityBucket(first.signal.tradedValue);
  return { symbol, date, signalIndex:first.index, signalTimestamp:new Date(milliseconds).toISOString(), signalPrice,
    action:first.signal.action, phase:first.signal.signalPhase || 'LEGACY', category:first.signal.category, araPhase:first.signal.araPhase || null,
    setupScore:ind.setupScore ?? null, triggerScore:ind.triggerScore ?? null, confirmationScore:ind.confirmationScore ?? null,
    entryEfficiencyScore:ind.entryEfficiencyScore ?? null, marketRegime:first.signal.marketRegime || 'unknown', liquidityBucket:bucket,
    dayMaxGainPct:pct(high, previousClose), signalChangePct:pct(signalPrice, previousClose), remainingUpsidePct:pct(futureHigh, signalPrice),
    capturedMoveRatio:totalMove > 0 ? Math.max(0, Math.min(1, (futureHigh - signalPrice) / totalMove)) : null,
    leadMinutesToHigh:lead(highBar), detectedBeforeHigh:new Date(highBar.timestamp).getTime() >= milliseconds,
    mfe:Math.max(0, pct(futureHigh, signalPrice)), mae:Math.min(0, pct(futureLow, signalPrice)),
    timeToMfeMinutes:lead(future.find((bar) => bar.high === futureHigh)), timeToMaeMinutes:lead(future.find((bar) => bar.low === futureLow)),
    forwardReturnPct:future.length ? pct(future.at(-1).close, signalPrice) : null,
    execution:evaluateExecution(future, signalPrice, bucket), execution5:evaluateExecution(future, signalPrice, bucket, { targetPct:5, stopPct:3 }) };
}

function quality(allDays, events) {
  const positives = events.filter((event) => event.dayMaxGainPct >= 5 && event.detectedBeforeHigh).length;
  const negatives = allDays.filter((day) => day.dayMaxGainPct < 5).length;
  const falsePositives = events.filter((event) => event.dayMaxGainPct < 5).length;
  const filled = events.filter((event) => event.execution.conservative != null);
  return { signalDays:events.length, precision:ratio(positives, events.length), falsePositiveRate:ratio(falsePositives, negatives),
    falseDiscoveryRate:ratio(events.length - positives, events.length), signalsPerTradingDay:ratio(events.length, new Set(allDays.map((day) => day.date)).size),
    medianMfe:percentile(events.map((event) => event.mfe), 0.5), medianMae:percentile(events.map((event) => event.mae), 0.5),
    worstMae:events.length ? Math.min(...events.map((event) => event.mae)) : null,
    averageForwardReturn:mean(events.map((event) => event.forwardReturnPct).filter(Number.isFinite)), medianForwardReturn:percentile(events.map((event) => event.forwardReturnPct), 0.5),
    conservativeExpectancyPct:mean(filled.map((event) => event.execution.conservativeReturnPct)), optimisticExpectancyPct:mean(filled.map((event) => event.execution.optimisticReturnPct)),
    conservativeWinRate:ratio(filled.filter((event) => event.execution.conservative).length, filled.length),
    probability3Before2:ratio(filled.filter((event) => event.execution.targetHit).length, filled.length),
    probability3Before2Optimistic:ratio(filled.filter((event) => event.execution.targetHitOptimistic).length, filled.length),
    probability5Before3:ratio(filled.filter((event) => event.execution5.targetHit).length, filled.length),
    ambiguousCount:filled.filter((event) => event.execution.ambiguous).length };
}

function summarizeEvents(allDays, events, segments = true) {
  const runnerCapture = {};
  for (const threshold of [5, 8, 12, 'nearARA']) {
    const eligible = (day) => day.dayMaxGainPct >= (threshold === 'nearARA' ? day.araThresholdPct * 0.9 : threshold);
    const runners = allDays.filter(eligible);
    const keys = new Set(runners.map((day) => `${day.symbol}|${day.date}`));
    const detected = events.filter((event) => keys.has(`${event.symbol}|${event.date}`) && event.detectedBeforeHigh);
    const changes = detected.map((event) => event.signalChangePct);
    const capture = { totalRunnerDays:runners.length, detectedRunnerDays:detected.length, recall:ratio(detected.length, runners.length),
      medianFirstSignalChangePct:percentile(changes, 0.5), meanFirstSignalChangePct:mean(changes), p25:percentile(changes, 0.25), p75:percentile(changes, 0.75),
      medianLeadMinutesToHigh:percentile(detected.map((event) => event.leadMinutesToHigh), 0.5), medianRemainingUpsidePct:percentile(detected.map((event) => event.remainingUpsidePct), 0.5),
      averageRemainingUpsidePct:mean(detected.map((event) => event.remainingUpsidePct)), medianCapturedMoveRatio:percentile(detected.map((event) => event.capturedMoveRatio), 0.5) };
    for (const boundary of [2, 3, 5, 8]) {
      const count = detected.filter((event) => event.signalChangePct < boundary).length;
      capture[`detectedBefore${boundary}Pct`] = ratio(count, runners.length);
      capture[`amongDetectedBefore${boundary}Pct`] = ratio(count, detected.length);
    }
    runnerCapture[threshold === 'nearARA' ? threshold : `gte${threshold}`] = capture;
  }
  const result = { runnerCapture, quality:quality(allDays, events) };
  if (segments) {
    result.segments = {};
    for (const field of ['setupScore', 'triggerScore', 'confirmationScore', 'entryEfficiencyScore', 'signalPrice', 'liquidityBucket', 'marketRegime', 'phase', 'category', 'araPhase']) {
      const groups = new Map();
      for (const event of events) {
        const value = event[field];
        const key = value == null ? 'unavailable' : field.endsWith('Score') ? String(Math.min(9, Math.floor(value / 10)))
          : field === 'signalPrice' ? value <= 200 ? '<=200' : value <= 5000 ? '201-5000' : '>5000' : value;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(event);
      }
      result.segments[field] = Object.fromEntries([...groups].map(([key, values]) => [key, quality(allDays, values)]));
    }
  }
  return result;
}

function chronologicalSplits(days) {
  const dates = [...new Set(days.map((day) => day.date))].sort();
  return { train:new Set(dates.slice(0, Math.floor(dates.length * 0.6))),
    validation:new Set(dates.slice(Math.floor(dates.length * 0.6), Math.floor(dates.length * 0.8))), test:new Set(dates.slice(Math.floor(dates.length * 0.8))) };
}

function evaluateStockData(dataset, options = {}) {
  const prepared = Object.fromEntries(Object.entries(dataset.stocks).map(([symbol, data]) => [symbol, { ...data, groups:groupByDay(data.intraday) }]));
  const allDates = [...new Set(Object.values(prepared).flatMap((data) => data.groups.map(([date]) => date)))].sort();
  const split = chronologicalSplits(allDates.map((date) => ({ date })));
  const selectedDates = options.split === 'development' ? new Set([...split.train, ...split.validation]) : split[options.split] || new Set(allDates);
  const events = [];
  const buyEvents = [];
  const allDays = [];
  let snapshots = 0;
  const discovery = options.discovery ? pipelineSelection(prepared, selectedDates, options) : null;
  for (const [symbol, data] of Object.entries(prepared)) {
    if (symbol === '^JKSE') continue;
    for (let d = 0; d < data.groups.length; d += 1) {
      const [date, bars] = data.groups[d];
      if (!selectedDates.has(date) || bars.length < 7 || minuteOfDay(bars[0].timestamp) !== 540 || minuteOfDay(bars.at(-1).timestamp) < 945) continue;
      const prior = completedDaily(data.daily, bars[0].timestamp);
      if (prior.length < 20 || !(mean(prior.slice(-20).map((row) => row.close * row.volume)) >= config.minimumTradedValue)) continue;
      const previousClose = prior.at(-1).close;
      allDays.push({ symbol, date, dayMaxGainPct:pct(Math.max(...bars.map((bar) => bar.high)), previousClose), araThresholdPct:previousClose <= 200 ? 35 : previousClose <= 5000 ? 25 : 20 });
      let first = null;
      let firstBuy = null;
      for (let i = 0; i < bars.length - 1; i += 1) {
        const engine = discovery ? (stock, market, session, histories) => {
          const enriched = discovery.get(stock.timestamp)?.has(symbol);
          return (options.engine || generateSignal)({ ...stock, avgVolume20:enriched ? stock.avgVolume20 : null }, market, session,
            enriched ? histories : { now:histories.now, ihsgDaily:histories.ihsgDaily });
        } : options.engine;
        const snapshot = snapshotAt(symbol, data.groups, d, i, { ...options, engine, daily:prior, ihsgDaily:prepared['^JKSE']?.daily,
          ihsgIntraday:prepared['^JKSE']?.groups.find(([key]) => key === date)?.[1] || [] });
        snapshots += 1;
        if (!snapshot) continue;
        if (options.onSnapshot) options.onSnapshot({ symbol, date, index:i, signal:snapshot.signal });
        if (!first && isMeaningful(snapshot.signal)) first = snapshot;
        if (!firstBuy && isMeaningful(snapshot.signal) && ['BUY', 'STRONG_BUY', 'HIGH_CONFIDENCE_BUY'].includes(snapshot.signal.action)) firstBuy = snapshot;
      }
      if (first) events.push(eventMetrics(symbol, date, bars, previousClose, first));
      if (firstBuy) buyEvents.push(eventMetrics(symbol, date, bars, previousClose, firstBuy));
    }
  }
  const report = { snapshots, overall:summarizeEvents(allDays, events), actionable:summarizeEvents(allDays, buyEvents), splits:{} };
  for (const [name, dates] of Object.entries(split)) if (name !== 'test' || options.split === 'test' || options.split === 'all') {
    report.splits[name] = summarizeEvents(allDays.filter((day) => dates.has(day.date)), events.filter((event) => dates.has(event.date)), false);
  }
  return { report, events, buyEvents, allDays };
}

function pipelineSelection(prepared, dates, options) {
  const selected = new Map();
  const state = new Map();
  for (const date of [...dates].sort()) {
    const days = Object.entries(prepared).filter(([symbol]) => symbol !== '^JKSE').map(([symbol, data]) => {
      const dayIndex = data.groups.findIndex(([key]) => key === date);
      return { symbol, data, dayIndex, bars:data.groups[dayIndex]?.[1] || [] };
    }).filter((day) => day.bars.length);
    const times = [...new Set(days.flatMap((day) => day.bars.map((bar) => bar.timestamp)))].sort();
    for (const timestamp of times) {
      const frames = days.map((day) => {
        const index = day.bars.findIndex((bar) => bar.timestamp === timestamp);
        return index < 0 ? null : snapshotAt(day.symbol, day.data.groups, day.dayIndex, index, {
          daily:day.data.daily, ihsgDaily:prepared['^JKSE']?.daily, engine:() => null,
        });
      }).filter(Boolean);
      if (!frames.length) continue;
      const now = frames[0].now;
      const quotes = frames.map((frame) => ({ ...frame.stock, avgVolume20:null }));
      const previous = [...state.values()].filter((row) => now - new Date(row.updatedAt) <= 3 * 86400000);
      const candidates = options.discovery === 'baseline'
        ? [...new Map([
          ...[...quotes].sort((a, b) => b.volume * b.lastPrice - a.volume * a.lastPrice).slice(0, 20),
          ...[...quotes].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 20),
        ].map((quote) => [quote.symbol, quote])).values()]
        : selectHistoryCandidates(quotes, previous, config.historyCandidateLimit);
      const symbols = new Set(candidates.map((quote) => quote.symbol));
      selected.set(now.toISOString(), symbols);
      if (options.discovery !== 'baseline') {
        for (const frame of frames.filter((frame) => symbols.has(frame.stock.symbol))) {
          // Only already selected histories may seed the next scan's optional discovery memory.
          const signal = generateSignal(frame.stock, {}, frame.session, frame.histories);
          if (signal.indicators.setupHistoryAvailable && signal.dataQuality >= 60) state.set(frame.stock.symbol, {
            symbol:frame.stock.symbol, setupScore:signal.setupScore, updatedAt:now.toISOString(),
          });
        }
      }
    }
  }
  return selected;
}

function run() {
  const input = path.resolve(process.argv[2] || '.replay-cache/replay-data.json');
  const split = process.argv[3] || 'development';
  if (!['development', 'train', 'validation', 'test', 'all'].includes(split)) throw new Error('Invalid split');
  const output = path.resolve(process.argv[4] || `.replay-cache/replay-${split}.json`);
  const content = fs.readFileSync(input);
  const dataset = JSON.parse(content);
  const report = { dataset:{ sha256:crypto.createHash('sha256').update(content).digest('hex'), capturedAt:dataset.capturedAt, selection:dataset.selection, failures:dataset.failures }, split, baselineRef:BASELINE_REF,
    assumptions:{ time:'Signal at completed 5-minute bar end, next-bar open entry; no auction or lunch signals', eligibility:'Prior 20-day mean traded value >= IDR500m, opening and closing coverage required',
      capturedMoveRatio:'clamp((futureHigh - signalPrice) / (dayHigh - previousClose),0,1); null for nonpositive denominator',
      execution:config.backtest, falsePositiveRate:'Nonrunner signal days / all eligible nonrunner days; falseDiscoveryRate is reported separately',
      detection:'Visible candidate category or BUY action, valid data and non-HIGH risk, strictly before day-high bar',
      limitations:['Current universe survivorship bias', 'No historical broker flow or corporate-action calendar', 'Five-minute OHLCV cannot prove queue availability', 'Regular-board ARA proxy only', 'Full-history comparison does not measure production history-selection misses'] }, engines:{} };
  if (process.argv.includes('--pipeline')) {
    report.assumptions.discovery = 'Original top-20 liquidity/top-20 absolute momentum union versus revised capped discovery with chronological optional state; quote averages unavailable until enrichment; state starts cold at the split boundary';
    report.assumptions.limitations.pop();
    report.assumptions.limitations.push('Sampled universe only; no claim of full-exchange discovery coverage or provider/cache latency');
  }
  for (const [name, engine] of [['baseline', baselineEngine()], ['revised', generateSignal]]) {
    const start = Date.now();
    const discovery = process.argv.includes('--pipeline') ? name : null;
    const result = evaluateStockData(dataset, { engine, split, discovery });
    report.engines[name] = { runtimeMs:Date.now() - start, symbolDays:result.allDays.length, ...result.report, events:result.events, buyEvents:result.buyEvents };
    console.log(JSON.stringify({ engine:name, split, runtimeMs:report.engines[name].runtimeMs, overall:result.report.overall.runnerCapture, quality:result.report.overall.quality }));
  }
  fs.mkdirSync(path.dirname(output), { recursive:true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(`Report: ${output}`);
}

if (require.main === module) { try { run(); } catch (error) { console.error(error); process.exitCode = 1; } }
module.exports = { BASELINE_REF, baselineEngine, groupByDay, dailyFromIntraday, snapshotAt, replayDay, evaluateExecution, eventMetrics, isMeaningful, percentile, chronologicalSplits, summarizeEvents, evaluateStockData, pipelineSelection };
