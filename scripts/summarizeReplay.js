'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chronologicalSplits, groupByDay, percentile } = require('./intradayBacktest');
const { dayKey, partitionIntraday } = require('../lib/market/historyContext');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const read = (name) => JSON.parse(fs.readFileSync(path.join('.replay-cache', name), 'utf8'));
const compact = ({ events, buyEvents, splits, ...metrics }) => metrics;

function paired(engines) {
  const baseline = new Map(engines.baseline.events.filter((event) => event.dayMaxGainPct >= 8 && event.detectedBeforeHigh).map((event) => [`${event.symbol}:${event.date}`, event]));
  const differences = engines.revised.events.filter((event) => event.dayMaxGainPct >= 8 && event.detectedBeforeHigh && baseline.has(`${event.symbol}:${event.date}`))
    .map((event) => event.signalChangePct - baseline.get(`${event.symbol}:${event.date}`).signalChangePct);
  return { commonDetectedRunnerDays:differences.length, earlier:differences.filter((value) => value < -1e-9).length,
    same:differences.filter((value) => Math.abs(value) <= 1e-9).length, later:differences.filter((value) => value > 1e-9).length,
    meanChangeDifferencePp:differences.length ? differences.reduce((a, b) => a + b, 0) / differences.length : null,
    medianChangeDifferencePp:percentile(differences, 0.5) };
}

function run() {
  const raw = fs.readFileSync('.replay-cache/replay-data.json');
  const dataset = JSON.parse(raw);
  const hash = sha256(raw);
  const dates = Object.values(dataset.stocks).flatMap((stock) => groupByDay(stock.intraday).map(([date]) => ({ date })));
  const report = { generatedAt:new Date().toISOString(), datasetSha256:hash,
    folds:Object.fromEntries(Object.entries(chronologicalSplits(dates)).map(([name, dates]) => [name, [...dates]])),
    sourceSha256:{}, intraday:{}, morning:{}, runtime:{}, productionReplayBarParity:{ symbolDays:0, passed:true } };
  for (const stock of Object.values(dataset.stocks)) {
    const rawDays = new Map();
    for (const bar of stock.intraday) {
      const date = dayKey(bar.timestamp);
      if (!rawDays.has(date)) rawDays.set(date, []);
      rawDays.get(date).push(bar);
    }
    for (const [date, expected] of groupByDay(stock.intraday)) {
      assert.deepEqual(partitionIntraday(rawDays.get(date), new Date(`${date}T17:00:00+07:00`)).current, expected);
      report.productionReplayBarParity.symbolDays += 1;
    }
  }
  for (const directory of ['lib/config', 'lib/engine', 'lib/market']) {
    for (const name of fs.readdirSync(directory).filter((name) => name.endsWith('.js'))) {
      const filename = `${directory}/${name}`;
      report.sourceSha256[filename] = sha256(fs.readFileSync(filename));
    }
  }
  for (const split of ['train', 'validation', 'test']) {
    const name = split === 'validation' ? 'replay-validation-v10.json' : `replay-${split}-frozen-v10.json`;
    const result = read(name);
    if (result.dataset.sha256 !== hash || result.split !== split) throw new Error(`Dataset/split mismatch: ${name}`);
    report.intraday[split] = { source:name, artifactSha256:sha256(fs.readFileSync(`.replay-cache/${name}`)),
      dataset:result.dataset, assumptions:result.assumptions, pairedGte8:paired(result.engines),
      engines:Object.fromEntries(Object.entries(result.engines).map(([name, metrics]) => [name, compact(metrics)])) };
  }
  for (const split of ['validation', 'test']) {
    const name = split === 'validation' ? 'morning-validation-final.json' : 'morning-test-frozen-v10.json';
    const result = read(name);
    if (result.datasetSha256 !== hash) throw new Error(`Dataset mismatch: ${name}`);
    report.morning[split] = { assumptions:result.assumptions,
      engines:Object.fromEntries(Object.entries(result.engines).map(([name, metrics]) => [name, compact(metrics)])) };
  }
  for (const route of ['scan', 'eveningScan']) report.runtime[route] = read(`runtime-${route}.json`);
  const output = process.argv[2] || 'reports/early-detection-2026-09-08.json';
  fs.mkdirSync(path.dirname(output), { recursive:true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(output);
}

if (require.main === module) run();
