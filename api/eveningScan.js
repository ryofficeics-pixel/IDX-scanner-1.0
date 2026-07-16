'use strict';

const cache = require('../lib/cache/memoryCache');
const idxData = require('../lib/providers/idxDataProvider');
const yahoo = require('../lib/providers/yahooProvider');
const { generateBowSignal } = require('../lib/engine/bowEngine');
const { getUniverse } = require('../lib/market/idxUniverse');
const { sessionContext } = require('../lib/market/idxSession');
const { setCors } = require('../lib/utils/http');
const foreignFlow = require('../lib/store/foreignFlowStore');

function send(res, status, body) { res.status(status).json(body); }

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgDailyVolume(candles) {
  const all = (candles || [])
    .map((c) => Number(c.volume))
    .filter((v) => Number.isFinite(v) && v > 0);
  const priorDays = all.length > 1 ? all.slice(0, -1) : all;
  const volumes = priorDays.slice(-20);
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

  const now = new Date();
  const session = sessionContext(now);
  const isAfterMarket = session.status === 'CLOSED' || session.status === 'PRE_OPEN';
  if (!isAfterMarket) {
    return send(res, 400, { ok:false, error:'Evening scan only available after market close (CLOSED / PRE_OPEN)', session: session.status });
  }

  const debug = req.query?.debug === '1';
  const limit = Math.max(1, Math.min(Number(req.query?.limit) || 50, 500));
  const universe = getUniverse({ symbols: req.query?.symbols, limit, offset: 0 });
  const symbols = universe.map((row) => row.symbol);
  const cacheKey = `evening:${symbols.join(',')}:${debug}`;
  const cached = cache.get(cacheKey, 60 * 1000);
  if (cached && !cached.stale) return send(res, 200, cached.value);

  const startedAt = Date.now();
  const diagnostics = { total: symbols.length, scanned: 0, failed: 0, latencyMs: 0 };

  // 1. Fetch IDX stock summary (today's close, volume, foreign flow)
  const idxSummary = await idxData.getBatchSummary({ bypassCache: debug });

  // 2. Fetch IHSG context
  const ihsgQuote = await idxData.getIHSG({ bypassCache: debug });
  const ihsgChangePct = ihsgQuote?.previousClose > 0 && ihsgQuote?.lastPrice > 0
    ? ((ihsgQuote.lastPrice - ihsgQuote.previousClose) / ihsgQuote.previousClose) * 100
    : null;

  // 3. Fetch daily history for top liquid + top momentum stocks
  const HISTORY_LIMIT = 30;
  const candidates = [];
  for (const s of symbols) {
    const row = idxSummary.get(s);
    if (row && row.lastPrice != null) {
      const liquidity = (row.volume || 0) * (row.lastPrice || 0);
      const momentum = row.previousClose > 0
        ? Math.abs((row.lastPrice - row.previousClose) / row.previousClose)
        : 0;
      candidates.push({ symbol: s, row, liquidity, momentum });
    }
  }
  candidates.sort((a, b) => (b.liquidity - a.liquidity) || (b.momentum - a.momentum));
  const topCandidates = candidates.slice(0, HISTORY_LIMIT);
  diagnostics.scanned = topCandidates.length;

  const results = [];
  const failures = [];
  await mapLimit(topCandidates, 8, async ({ symbol, row }) => {
    try {
      const daily = await yahoo.getDailyHistory(`${symbol}.JK`, '1y', '1d');
      const avgVol = avgDailyVolume(daily);
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
        source: 'idx-surface',
        timestamp: new Date().toISOString(),
      };
      // Persist and fetch cumulative foreign flow
      if (row.netBuy != null) {
        setImmediate(() => foreignFlow.record(symbol, row.netBuy, row.foreignBuy, row.foreignSell));
        const cum3d = await foreignFlow.getCumulative3d(symbol);
        if (cum3d) {
          stock.cumulative3dNetBuy = cum3d.cumulative;
          stock.cumulative3dDays = cum3d.days;
        }
      }
      const market = {
        ihsgPrice: ihsgQuote?.lastPrice ?? null,
        ihsgChangePct,
        source: ihsgQuote?.source || 'idx-surface',
        timestamp: new Date().toISOString(),
      };
      const bow = generateBowSignal(stock, market, { daily, now });
      if (bow && bow.score >= 60) results.push(bow);
    } catch (err) {
      failures.push(symbol);
    }
  });

  diagnostics.failed = failures.length;
  diagnostics.latencyMs = Date.now() - startedAt;

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
