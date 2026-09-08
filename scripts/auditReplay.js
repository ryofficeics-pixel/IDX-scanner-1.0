'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { evaluateStockData } = require('./intradayBacktest');

function run() {
  const input = process.argv[2] || '.replay-cache/replay-data.json';
  const output = process.argv[3] || '.replay-cache/train-audit.json';
  const raw = fs.readFileSync(input);
  const snapshots = [];
  const start = Date.now();
  const result = evaluateStockData(JSON.parse(raw), { split:'train', onSnapshot: (row) => snapshots.push(row) });
  fs.writeFileSync(output, JSON.stringify({ datasetSha256:crypto.createHash('sha256').update(raw).digest('hex'), split:'train',
    runtimeMs:Date.now() - start, ...result, snapshots }));
  console.log(JSON.stringify({ runtimeMs:Date.now() - start, overall:result.report.overall, output }));
}

if (require.main === module) run();
