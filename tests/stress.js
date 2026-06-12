'use strict';

const http = require('http');
const { startServer } = require('./localServer');

function requestUrl(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode || 0 }));
    });
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
  });
}

async function runOne(baseUrl, path, { concurrency = 5, durationMs = 5000 } = {}) {
  const url = `${baseUrl}${path}`;
  const warm = await requestUrl(url);
  if (warm.status < 200 || warm.status >= 300) throw new Error(`${path} warmup failed with ${warm.status}`);

  const counters = { total: 0, non2xx: 0 };
  const deadline = Date.now() + durationMs;

  async function worker() {
    while (Date.now() < deadline) {
      try {
        const response = await requestUrl(url);
        counters.total += 1;
        if (response.status < 200 || response.status >= 300) counters.non2xx += 1;
      } catch (_) {
        counters.total += 1;
        counters.non2xx += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const non200Ratio = counters.total ? counters.non2xx / counters.total : 0;
  console.log(`${path} requests=${counters.total} non2xx=${counters.non2xx} ratio=${(non200Ratio * 100).toFixed(2)}%`);
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
