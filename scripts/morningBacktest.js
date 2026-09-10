'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { generateMorningSignal } = require('../lib/engine/bowEngine');
const { completedDaily, dayKey, minuteOfDay } = require('../lib/market/historyContext');
const { baselineEngine, groupByDay, chronologicalSplits, eventMetrics, summarizeEvents } = require('./intradayBacktest');
const config = require('../lib/config/signalConfig');

function evaluateMorning(dataset, split, engine = generateMorningSignal) {
  const prepared = Object.fromEntries(Object.entries(dataset.stocks).map(([symbol, data]) => [symbol, { ...data, groups:groupByDay(data.intraday) }]));
  const dates = chronologicalSplits(Object.values(prepared).flatMap((data) => data.groups.map(([date]) => ({ date }))));
  if (!dates[split]) throw new Error('Choose train, validation, or test');
  const allDays = [], events = [], bowEvents = [];
  for (const [symbol, data] of Object.entries(prepared)) {
    if (symbol === '^JKSE') continue;
    for (let i = 0; i < data.groups.length - 1; i += 1) {
      const [date] = data.groups[i];
      const [nextDate, nextBars] = data.groups[i + 1];
      // Purge the split boundary: an evening label must resolve inside the same fold.
      if (!dates[split].has(date) || !dates[split].has(nextDate) || minuteOfDay(nextBars[0]?.timestamp) !== 540 || minuteOfDay(nextBars.at(-1)?.timestamp) < 945) continue;
      const now = new Date(`${date}T17:00:00+07:00`);
      const daily = completedDaily(data.daily, now);
      if (daily.length < 80 || dayKey(daily.at(-1).timestamp || daily.at(-1).date) !== date) continue;
      const today = daily.at(-1);
      const prior = daily.slice(-21, -1);
      if (prior.reduce((sum, row) => sum + row.close * row.volume, 0) / 20 < config.minimumTradedValue) continue;
      const ihsgDaily = completedDaily(prepared['^JKSE']?.daily || [], now);
      const market = { ihsgReturn3M:ihsgDaily.length > 63 ? (ihsgDaily.at(-1).close / ihsgDaily.at(-64).close - 1) * 100 : null };
      const stock = { symbol, lastPrice:today.close, previousClose:daily.at(-2).close, dayOpen:today.open, dayHigh:today.high,
        dayLow:today.low, volume:today.volume, avgVolume20:prior.reduce((sum, row) => sum + row.volume, 0) / 20,
        timestamp:now.toISOString(), source:'completed-daily-replay' };
      const signal = engine(stock, market, { daily, ihsgDaily, now });
      allDays.push({ symbol, date:nextDate, dayMaxGainPct:(Math.max(...nextBars.map((bar) => bar.high)) / today.close - 1) * 100,
        araThresholdPct:today.close <= 200 ? 35 : today.close <= 5000 ? 25 : 20 });
      if (signal.action !== 'BOW_BUY' && !signal.morningEligible) continue;
      const event = eventMetrics(symbol, nextDate, nextBars, today.close, { index:-1,
        bar:{ timestamp:new Date(now.getTime() - 300000).toISOString() },
        signal:{ ...signal, lastPrice:today.close, tradedValue:today.close * today.volume,
          indicators:{ setupScore:signal.setupScore }, signalPhase:signal.action === 'BOW_BUY' ? 'BOW_SETUP' : 'MORNING_SETUP' } });
      events.push({ ...event, setupDate:date, nextOpenGapPct:(nextBars[0].open / today.close - 1) * 100 });
      if (signal.action === 'BOW_BUY') bowEvents.push(event);
    }
  }
  return { symbolDays:allDays.length, overall:summarizeEvents(allDays, events), bow:summarizeEvents(allDays, bowEvents), events };
}

function run() {
  const raw = fs.readFileSync(process.argv[2] || '.replay-cache/replay-data.json');
  const split = process.argv[3] || 'validation';
  const dataset = JSON.parse(raw);
  const old = baselineEngine('lib/engine/bowEngine.js', 'generateBowSignal');
  const report = { datasetSha256:crypto.createHash('sha256').update(raw).digest('hex'), split,
    assumptions:['Setup known at 17:00 WIB; entry next session open, not the already closed market',
      'Next-open gap is descriptive, not an executable overnight return', 'Split boundary purged',
      'No historical foreign flow; sampled universe, no overnight profitability claim'], engines:{} };
  for (const [name, engine] of [['baseline', old], ['revised', generateMorningSignal]]) {
    report.engines[name] = evaluateMorning(dataset, split, engine);
    console.log(name, JSON.stringify(report.engines[name].overall.quality));
  }
  const output = process.argv[4] || `.replay-cache/morning-${split}.json`;
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(output);
}

if (require.main === module) run();
module.exports = { evaluateMorning };
