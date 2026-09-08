'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { classifySignal } = require('../lib/engine/signalEngine');
const { marketRegime } = require('../lib/engine/regimeEngine');
const { evaluateStockData, baselineEngine } = require('./intradayBacktest');

function run() {
  const raw = fs.readFileSync('.replay-cache/replay-data.json');
  const audit = JSON.parse(fs.readFileSync('.replay-cache/train-audit.json'));
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  if (audit.split !== 'train' || audit.datasetSha256 !== hash) throw new Error('Training cache dataset/split mismatch');
  const cached = new Map(audit.snapshots.map((row) => [`${row.symbol}|${row.signal.timestamp}`, row.signal.indicators]));
  const engine = (stock, market, session, histories) => {
    const indicators = cached.get(`${stock.symbol}|${stock.timestamp}`);
    if (!indicators) throw new Error(`Missing training snapshot ${stock.symbol} ${stock.timestamp}`);
    return classifySignal(stock, market, session, { ...indicators }, marketRegime(market, histories.ihsgDaily), histories.now);
  };
  const start = Date.now();
  const dataset = JSON.parse(raw);
  const result = evaluateStockData(dataset, { split:'train', engine });
  const report = { datasetSha256:hash, split:'train', runtimeMs:Date.now() - start, ...result };
  if (process.argv.includes('--baseline')) report.baseline = evaluateStockData(dataset, { split:'train', engine:baselineEngine() });
  const output = process.argv[2] || '.replay-cache/train-reclassified.json';
  fs.writeFileSync(output, JSON.stringify(report));
  console.log(JSON.stringify({ output, runtimeMs:report.runtimeMs, runnerCapture:result.report.overall.runnerCapture, quality:result.report.overall.quality }));
}

if (require.main === module) run();
