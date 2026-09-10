'use strict';

const cache = require('../lib/cache/memoryCache');
const idxData = require('../lib/providers/idxDataProvider');
const yahoo = require('../lib/providers/yahooProvider');
const { generateMorningSignal } = require('../lib/engine/bowEngine');
const { getUniverse } = require('../lib/market/idxUniverse');
const { sessionContext } = require('../lib/market/idxSession');
const { setCors } = require('../lib/utils/http');
const foreignFlow = require('../lib/store/foreignFlowStore');
const { selectHistoryCandidates } = require('../lib/engine/candidateDiscovery');
const { completedDaily } = require('../lib/market/historyContext');
const candidateState = require('../lib/store/candidateState');
const { providerBudget } = require('../lib/utils/async');

function send(res, status, body) { res.status(status).json(body); }

function avgDailyVolume(candles, now) {
  const all = completedDaily(candles || [], now)
    .map((c) => Number(c.volume))
    .filter((v) => Number.isFinite(v) && v > 0);
  const volumes = all.slice(-20);
  return volumes.length ? volumes.reduce((sum, v) => sum + v, 0) / volumes.length : null;
}

async function mapLimit(items, limit, worker) {
  const out = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { ok:false, error:'METHOD_NOT_ALLOWED' });

  const debug = req.query?.debug === '1';
  const mockTime = debug && req.query?.mockTime ? new Date(req.query.mockTime) : null;
  const now = mockTime && Number.isFinite(mockTime.getTime()) ? mockTime : new Date();
  const session = sessionContext(now);
  const isAfterMarket = session.status === 'CLOSED' || session.status === 'PRE_OPEN';
  if (!isAfterMarket) {
    return send(res, 400, { ok:false, error:'Evening scan only available after market close (CLOSED / PRE_OPEN)', session: session.status });
  }

  const limit = Math.max(1, Math.min(Number(req.query?.limit) || 50, 500));
  const universe = getUniverse({ symbols: req.query?.symbols, limit, offset: 0 });
  const symbols = universe.map((row) => row.symbol);
  const cacheKey = `evening:${symbols.join(',')}:${debug ? JSON.stringify(req.query) : 'normal'}`;
  const cached = cache.get(cacheKey, 60 * 1000);
  if (cached && !cached.stale) return send(res, 200, cached.value);

  const startedAt = Date.now();
  const bounded = providerBudget();
  const diagnostics = { total: symbols.length, scanned: 0, failed: 0, latencyMs: 0, warnings:[] };

  // 1. Fetch IDX stock summary (today's close, volume, foreign flow)
  const [idxSummary, quotes] = await Promise.all([
    bounded('EVENING_SUMMARY', 9000, () => idxData.getBatchSummary({ bypassCache:debug })).catch(() => new Map()),
    bounded('EVENING_QUOTES', 15000, () => idxData.getBatchQuotes(symbols, { bypassCache:debug })).catch(() => ({ quotes:{} })),
  ]);

  // 2. Fetch IHSG context
  const [ihsgQuote, ihsgHistory] = await Promise.all([
    bounded('EVENING_IHSG', 9000, () => idxData.getIHSG({ bypassCache:debug })).catch(() => null),
    bounded('EVENING_IHSG_HISTORY', 8000, () => yahoo.getDailyHistory('^JKSE', '1y', '1d')).catch(() => []),
  ]);
  const ihsgDaily = completedDaily(ihsgHistory, now);
  const ihsgReturn3M = ihsgDaily.length > 63 ? (ihsgDaily.at(-1).close / ihsgDaily.at(-64).close - 1) * 100 : null;
  const ihsgChangePct = ihsgQuote?.previousClose > 0 && ihsgQuote?.lastPrice > 0
    ? ((ihsgQuote.lastPrice - ihsgQuote.previousClose) / ihsgQuote.previousClose) * 100
    : null;

  // Enrich the bounded discovery union, including quiet setups.
  const priorStates = debug ? [] : await candidateState.read(symbols, now);
  const candidateQuotes = symbols.map((symbol) => ({ ...(idxSummary.get(symbol) || {}), ...(quotes.quotes?.[symbol] || {}), symbol }));
  const topCandidates = selectHistoryCandidates(candidateQuotes, priorStates, 60).map((row) => ({ symbol:row.symbol, row }));
  diagnostics.candidatePass1Count = candidateQuotes.filter((row) => row.lastPrice > 0).length;
  diagnostics.historyCandidateCount = topCandidates.length;
  diagnostics.scanned = topCandidates.length;

  const results = [];
  const failures = [];
  await mapLimit(topCandidates, 8, async ({ symbol, row }) => {
    try {
      const daily = completedDaily(await bounded(`EVENING_DAILY_${symbol}`, 12000, () => yahoo.getDailyHistory(`${symbol}.JK`, '1y', '1d')), now);
      const avgVol = avgDailyVolume(daily, now);
      const stock = {
        symbol,
        yahooSymbol: `${symbol}.JK`,
        name: symbol,
        lastPrice: row.lastPrice,
        previousClose: row.previousClose,
        dayHigh: row.dayHigh || row.lastPrice,
        dayLow: row.dayLow || row.lastPrice,
        volume: row.volume,
        avgVolume20: avgVol,
        marketCap: null,
        netBuy: row.netBuy,
        foreignBuy: row.foreignBuy,
        foreignSell: row.foreignSell,
        source: row.source || 'idx-surface',
        timestamp: row.timestamp || null,
        timestampSource: row.timestampSource || (row.timestamp ? 'provider' : 'fetch'),
      };
      // Persist and fetch cumulative foreign flow
      if (row.netBuy != null) {
        if (!debug && row.tradeDate === now.toLocaleDateString('en-CA', { timeZone:'Asia/Jakarta' })) {
          await bounded('EVENING_FLOW_RECORD', 1500, () => foreignFlow.record(symbol, row.netBuy, row.foreignBuy, row.foreignSell, row.tradeDate)).catch(() => null);
        }
        const cum3d = await bounded('EVENING_FLOW_HISTORY', 1500, () => foreignFlow.getCumulative3d(symbol, now)).catch(() => null);
        if (cum3d) {
          stock.cumulative3dNetBuy = cum3d.cumulative;
          stock.cumulative3dDays = cum3d.days;
        }
      }
      const market = {
        ihsgPrice: ihsgQuote?.lastPrice ?? null,
        ihsgChangePct,
        ihsgReturn3M,
        source: ihsgQuote?.source || 'idx-surface',
        timestamp: new Date().toISOString(),
      };
      const bow = generateMorningSignal(stock, market, { daily, ihsgDaily, now });
      if (bow && (bow.action === 'BOW_BUY' || bow.morningEligible)) results.push(bow);
    } catch (err) {
      failures.push(symbol);
    }
  });

  diagnostics.failed = failures.length;
  diagnostics.latencyMs = Date.now() - startedAt;
  diagnostics.providerBudgetExhausted = diagnostics.latencyMs >= 45000;
  if (!ihsgQuote) diagnostics.warnings.push('IHSG quote unavailable; benchmark context is partial');

  results.sort((a, b) => {
    const aBoom = a.morningBoom?.score ?? 0;
    const bBoom = b.morningBoom?.score ?? 0;
    if (bBoom !== aBoom) return bBoom - aBoom;
    return (b.score || 0) - (a.score || 0);
  });

  const morningBoomPicks = results.filter((r) => r.morningBoom?.score >= 50).slice(0, 20);
  const bowWatchlist = results.filter((r) => r.score >= 70 && (!r.morningBoom || r.morningBoom.score < 50)).slice(0, 10);

  const payload = {
    ok: true,
    mode: 'evening-scan',
    generatedAt: now.toISOString(),
    marketDate: now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }),
    timezone: 'Asia/Jakarta',
    session: { status: session.status, timezone: 'Asia/Jakarta' },
    market: { ihsgChangePct, source: ihsgQuote?.source || 'idx-surface' },
    summary: {
      scanned: diagnostics.scanned,
      total: diagnostics.total,
      morningBoomCount: morningBoomPicks.length,
      bowWatchlistCount: bowWatchlist.length,
      failedCount: diagnostics.failed,
    },
    morningBoomPicks,
    bowWatchlist,
    diagnostics,
  };
  cache.set(cacheKey, payload);
  return send(res, 200, payload);
};
