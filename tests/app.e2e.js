'use strict';

const { test, expect } = require('@playwright/test');
const { startServer } = require('./localServer');

let local;

function sampleScan(overrides = {}) {
  const now = new Date();
  const base = {
    ok:true,
    generatedAt:now.toISOString(),
    lastUpdated:now.toISOString(),
    marketDate:now.toLocaleDateString('en-CA', { timeZone:'Asia/Jakarta' }),
    timezone:'Asia/Jakarta',
    session:{ status:'MORNING', sessionProgress:0.2, expectedVolumeProgress:0.3 },
    market:{ ihsgPrice:7000, ihsgChangePct:0.2, source:'unit', timestamp:now.toISOString() },
    summary:{ scanned:1, valid:1, noData:0, strongBuyCount:0, buyCount:1, holdCount:0, sellCount:0, topGainerCount:1, accumulationProxyCount:0, distributionProxyCount:0, errorCount:0 },
    recommendations:{
      strongBuy:[], beliPagi:[], beliSore:[],
      topBuy:[{ symbol:'BBCA', name:'BBCA', lastPrice:1000, previousClose:980, changePct:2.04, volume:1000000, avgVolume20:500000, tradedValue:1e9, score:75, action:'BUY', category:'TOP_BUY', riskLevel:'LOW', dataQuality:90, confidence:80, reasons:['Momentum positif'], warnings:[], indicators:{ rangePosition:0.8, projectedVolRatio:2, liquidityScore:60 }, source:'unit', timestamp:now.toISOString() }],
      topGainers:[], accumulationProxy:[], distributionProxy:[], risk:[], hold:[], sell:[],
    },
    diagnostics:{ provider:'unit', providerPrimaryStatus:'ok', providerFallbackStatus:'not_needed', providerLatencyMs:1, cacheHit:false, cacheAgeMs:0, scanStartedAt:now.toISOString(), scanFinishedAt:now.toISOString(), dataFreshness:'live', failedSymbols:[], validRatio:1, noDataRatio:0, warnings:[], errors:[] },
  };
  return { ...base, ...overrides };
}

function cacheEnvelope(payload) {
  return JSON.stringify({
    payload,
    savedAt:Date.now(),
    marketDate:payload.marketDate,
    provider:payload.diagnostics.provider,
    diagnostics:payload.diagnostics,
  });
}

test.beforeAll(async () => {
  local = await startServer();
});

test.afterAll(async () => {
  await local.close();
});

test('fresh open runs scan and does not require CSV', async ({ page }) => {
  await page.route('**/api/scan**', (route) => route.fulfill({ contentType:'application/json', body:JSON.stringify(sampleScan()) }));
  await page.goto(local.url);
  await page.evaluate(() => localStorage.clear());
  const scanResponse = page.waitForResponse((res) => res.url().includes('/api/scan') && res.status() === 200);
  await page.reload();
  await scanResponse;
  await expect(page.locator('body')).toContainText('SIGNAL REKOMENDASI');
  await expect(page.locator('body')).not.toContainText('Import CSV flow');
  await expect(page.locator('body')).not.toContainText('Strong Buy hanya valid jika flow lengkap');
});

test('scan success renders metadata and signal area', async ({ page }) => {
  await page.route('**/api/scan**', (route) => route.fulfill({ contentType:'application/json', body:JSON.stringify(sampleScan()) }));
  await page.goto(local.url);
  await expect(page.locator('body')).toContainText('Last updated');
  await expect(page.locator('body')).toContainText('Provider');
  await expect(page.locator('body')).toContainText('LIVE');
  await expect(page.locator('body')).toContainText('TOP BUY SIGNALS');
});

test('optional external enrichment renders without changing the core signal', async ({ page }) => {
  await page.route('**/api/scan**', (route) => route.fulfill({ contentType:'application/json', body:JSON.stringify(sampleScan()) }));
  await page.route('**/api/enrich**', (route) => route.fulfill({ contentType:'application/json', body:JSON.stringify({
    ok:true,
    generatedAt:new Date().toISOString(),
    requestedSymbols:['BBCA'],
    matchedSymbols:['BBCA'],
    scoringImpact:'none',
    sources:{
      telmi:{ provider:'telmi', configured:true, status:'ok', matched:1, errors:[] },
      stockbit:{ provider:'stockbit-gateway', configured:false, status:'disabled', matched:0, errors:[] },
    },
    enrichments:{ BBCA:{
      telmi:{ signal:'BUY', indicator:'Smart Money Accumulation', areaBuyMin:950, areaBuyMax:1000, tp1:1100, sl:920 },
      consensus:{ status:'single_source', positive:1, negative:0, neutral:0, votes:[{ source:'telmi', direction:'positive' }] },
    } },
  }) }));
  await page.goto(local.url);
  await expect(page.locator('body')).toContainText('EXT 1');
  await page.evaluate(() => openDetail('BBCA'));
  await page.getByRole('button', { name:'External' }).click();
  await expect(page.locator('#page-detail')).toContainText('Smart Money Accumulation');
  await expect(page.locator('#page-detail')).toContainText('tidak mengubah score inti');
  await expect(page.locator('#page-detail')).toContainText('Stockbit Gateway');
});

test('API failure with cache renders cached result as cache mode', async ({ page }) => {
  const payload = sampleScan();
  await page.addInitScript((value) => localStorage.setItem('idx_flow_cache_v2', value), cacheEnvelope(payload));
  await page.route('**/api/scan**', (route) => route.abort());
  await page.goto(local.url);
  await expect(page.locator('body')).toContainText('CACHE');
  await expect(page.locator('body')).toContainText('SIGNAL REKOMENDASI');
});

test('API failure without cache does not crash', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.route('**/api/scan**', (route) => route.abort());
  await page.goto(local.url);
  await expect(page.locator('body')).toContainText('IDX FLOW');
  await expect(page.locator('body')).not.toContainText('Import CSV flow');
});

test('stale cache warning appears', async ({ page }) => {
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const payload = sampleScan({ generatedAt:old, lastUpdated:old });
  await page.addInitScript((value) => localStorage.setItem('idx_flow_cache_v2', value), cacheEnvelope(payload));
  await page.route('**/api/scan**', (route) => route.abort());
  await page.goto(local.url);
  await expect(page.locator('body')).toContainText('STALE DATA');
});

test('corrupt localStorage recovers', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('idx_flow_cache_v2', '{bad-json'));
  await page.route('**/api/scan**', (route) => route.fulfill({ contentType:'application/json', body:JSON.stringify(sampleScan()) }));
  await page.goto(local.url);
  await expect(page.locator('body')).toContainText('SIGNAL REKOMENDASI');
});

test('mobile viewport remains usable', async ({ page }) => {
  await page.setViewportSize({ width:390, height:844 });
  await page.route('**/api/scan**', (route) => route.fulfill({ contentType:'application/json', body:JSON.stringify(sampleScan()) }));
  await page.goto(local.url);
  await expect(page.locator('#navbar')).toBeVisible();
  await expect(page.locator('#topbar')).toBeVisible();
});

test('empty TOP BUY state is explicit', async ({ page }) => {
  const payload = sampleScan({
    summary:{ scanned:1, valid:1, noData:0, strongBuyCount:0, buyCount:0, holdCount:1, sellCount:0, topGainerCount:0, accumulationProxyCount:0, distributionProxyCount:0, errorCount:0 },
    recommendations:{ strongBuy:[], beliPagi:[], beliSore:[], topBuy:[], topGainers:[], accumulationProxy:[], distributionProxy:[], risk:[], hold:[], sell:[] },
  });
  await page.route('**/api/scan**', (route) => route.fulfill({ contentType:'application/json', body:JSON.stringify(payload) }));
  await page.goto(local.url);
  await expect(page.locator('body')).toContainText('Belum ada BUY valid dari auto scan saat ini');
});
