'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yahoo = require('../lib/providers/yahooProvider');
const { getUniverse } = require('../lib/market/idxUniverse');

async function run() {
  const output = path.resolve(process.argv[2] || '.replay-cache/replay-data.json');
  if (fs.existsSync(output)) throw new Error('Dataset already exists; choose another output to preserve the frozen sample');
  const universe = getUniverse({ limit:1000 });
  const symbols = [...new Set([...universe.slice(0, 20), ...Array.from({ length:20 }, (_, i) => universe[Math.floor(i * universe.length / 20)])].map((row) => row.symbol))];
  const data = { capturedAt:new Date().toISOString(), selection:'First 20 repository symbols plus 20 evenly spaced universe members; selected without future returns', requestedSymbols:symbols, provider:'Yahoo chart 60d/5m and 1y/1d', stocks:{}, failures:[] };
  let cursor = 0;
  const requested = ['^JKSE', ...symbols];
  await Promise.all(Array.from({ length:4 }, async () => {
    while (cursor < requested.length) {
      const symbol = requested[cursor++];
      const [intraday, daily] = await Promise.allSettled([yahoo.getIntradayHistory(symbol, '60d', '5m'), yahoo.getDailyHistory(symbol, '1y', '1d')]);
      if (intraday.status === 'fulfilled' && daily.status === 'fulfilled' && intraday.value.length && daily.value.length) {
        data.stocks[symbol] = { intraday:intraday.value, daily:daily.value };
        console.log(`${symbol}: ${intraday.value.length} intraday, ${daily.value.length} daily`);
      } else { data.failures.push(symbol); console.log(`${symbol}: unavailable`); }
    }
  }));
  fs.mkdirSync(path.dirname(output), { recursive:true });
  const content = JSON.stringify(data);
  fs.writeFileSync(output, content, { flag:'wx' });
  console.log(JSON.stringify({ output, sha256:crypto.createHash('sha256').update(content).digest('hex'), symbols:Object.keys(data.stocks).length, failures:data.failures }));
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
