'use strict';

const autocannon = require('autocannon');
const { startServer } = require('./localServer');

async function runOne(baseUrl, path) {
  const warm = await fetch(`${baseUrl}${path}`);
  if (!warm.ok) throw new Error(`${path} warmup failed with ${warm.status}`);
  await warm.text();
  const result = await autocannon({
    url: `${baseUrl}${path}`,
    connections: 5,
    duration: 5,
    timeout: 30,
  });
  const total = result['2xx'] + result.non2xx;
  const non200Ratio = total ? result.non2xx / total : 0;
  console.log(`${path} requests=${total} non2xx=${result.non2xx} ratio=${(non200Ratio * 100).toFixed(2)}%`);
  if (non200Ratio > 0.02) throw new Error(`${path} exceeded 2% non-200 responses`);
}

(async () => {
  const local = await startServer();
  try {
    await runOne(local.url, '/api/health');
    await runOne(local.url, '/api/scan?symbols=BBCA,BBRI,BMRI&debug=1');
    await runOne(local.url, '/api/scan?limit=120&debug=1');
  } finally {
    await local.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
