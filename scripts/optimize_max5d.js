'use strict';

const { generateSignal } = require('../lib/engine/signalEngine');
const { getUniverse } = require('../lib/market/idxUniverse');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function fetchDailyCharts(symbols, years = 2) {
  const results = {};
  for (const symbol of symbols) {
    const yahooSym = symbol === '^JKSE' ? '^JKSE' : `${symbol}.JK`;
    try {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=5y&interval=1d`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IDXScanner/3.0)', Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const timestamps = result.timestamp || [];
      const ohlc = result.indicators?.quote?.[0] || {};
      const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];
      const candles = [];
      const cutoff = Date.now() - years * 365.25 * 24 * 60 * 60 * 1000;
      for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i] * 1000;
        if (t < cutoff) continue;
        candles.push({
          date: new Date(t).toISOString().slice(0, 10),
          timestamp: new Date(t).toISOString(),
          open: ohlc.open?.[i], high: ohlc.high?.[i], low: ohlc.low?.[i],
          close: ohlc.close?.[i], volume: ohlc.volume?.[i], adjclose: adjclose[i] || ohlc.close?.[i],
        });
      }
      const valid = candles.filter((c) => num(c.close) != null);
      if (valid.length >= 220) results[symbol] = valid;
    } catch { }
  }
  return results;
}

async function run() {
  console.log('=== MAX5D WIN RATE OPTIMIZER ===\n');
  const universe = getUniverse({});
  const allSymbols = universe.map((r) => r.symbol);
  const charts = await fetchDailyCharts(['^JKSE', ...allSymbols], 2);
  delete charts['^JKSE'];
  const symbols = Object.keys(charts).sort();
  console.log(`Analyzing ${symbols.length} stocks...\n`);

  const START_DAYS = 220;
  const rows = [];

  for (const symbol of symbols) {
    const candles = charts[symbol];
    if (!candles || candles.length < START_DAYS + 6) continue;
    for (let d = START_DAYS; d < candles.length - 6; d++) {
      const today = candles[d], prev = candles[d - 1];
      const dailyHistory = candles.slice(0, d);
      const open = num(today.open) ?? num(today.close);
      const high = num(today.high) ?? num(today.close);
      const low = num(today.low) ?? num(today.close);
      const close = num(today.close);
      const volume = num(today.volume) ?? 0;
      const prevClose = num(prev.close) ?? close;
      if (!close) continue;
      const avgVolumeArr = dailyHistory.slice(-20).map((c) => num(c.volume)).filter((v) => v != null);
      const avgVolume20 = avgVolumeArr.length ? avgVolumeArr.reduce((a, b) => a + b, 0) / avgVolumeArr.length : null;
      const stock = {
        symbol, yahooSymbol: `${symbol}.JK`, name: symbol, lastPrice: close, previousClose: prevClose,
        dayHigh: high, dayLow: low, volume, avgVolume20,
        changePct: prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0,
        timestamp: today.timestamp, marketState: 'REGULAR', source: 'yahoo-finance',
      };
      const ihsgCloses = charts['^JKSE'] ? charts['^JKSE'].slice(0, d).map((c) => num(c.close)).filter((v) => v != null) : [];
      const ihsgChangePct = ihsgCloses.length >= 2 && ihsgCloses[ihsgCloses.length - 2] > 0
        ? ((ihsgCloses[ihsgCloses.length - 1] - ihsgCloses[ihsgCloses.length - 2]) / ihsgCloses[ihsgCloses.length - 2]) * 100 : 0;
      const marketContext = { ihsgChangePct };
      const sessionStub = { status: 'AFTERNOON', sessionProgress: 0.85, expectedVolumeProgress: 0.75, timezone: 'Asia/Jakarta' };
      const histories = { daily: dailyHistory, intraday: [{ open, high, low, close, volume }], now: new Date(today.timestamp) };
      const sig = generateSignal(stock, marketContext, sessionStub, histories);
      const ind = sig.indicators;
      const maxRet5 = Math.max(...[1, 2, 3, 4, 5].map((k) => candles[d + k] ? (num(candles[d + k].close) - close) / close * 100 : -Infinity));
      const minRet5 = Math.min(...[1, 2, 3, 4, 5].map((k) => candles[d + k] ? (num(candles[d + k].close) - close) / close * 100 : Infinity));
      rows.push({
        action: sig.action, score: sig.score, changePct: sig.changePct,
        max5: maxRet5 === -Infinity ? null : maxRet5,
        min5: minRet5 === Infinity ? null : minRet5,
        win5: maxRet5 != null && maxRet5 > 0,
        // indicators
        dts: ind.dailyTrendScore, brk: ind.breakoutScore, vol: ind.projectedVolRatio,
        fade: ind.lateFadeScore, rangePos: ind.rangePosition, rsi: ind.rsiDaily,
        macdH: ind.macdHistogram, macdB: ind.macdBullish, stochB: ind.stochBullish,
        sma5: ind.sma5, sma20: ind.sma20, atrPct: ind.atrPct, gap: ind.gapControlScore,
        volC: ind.volatilityControlScore, liq: ind.liquidityScore, accel: ind.acceleration,
      });
    }
  }

  const buys = rows.filter((r) => r.action === 'BUY' || r.action === 'STRONG_BUY');
  console.log(`Total BUY signals: ${buys.length}`);
  const baseWin = buys.filter((r) => r.win5).length / buys.length * 100;
  console.log(`Baseline max5d win rate: ${baseWin.toFixed(1)}%\n`);

  // Filter sweep on max5d win rate
  const filters = [
    { name: 'dts>=55', fn: (r) => r.dts >= 55 },
    { name: 'dts>=60', fn: (r) => r.dts >= 60 },
    { name: 'dts>=65', fn: (r) => r.dts >= 65 },
    { name: 'brk>=40', fn: (r) => r.brk >= 40 },
    { name: 'brk>=50', fn: (r) => r.brk >= 50 },
    { name: 'vol>=1.3', fn: (r) => r.vol >= 1.3 },
    { name: 'vol>=1.5', fn: (r) => r.vol >= 1.5 },
    { name: 'vol>=2.0', fn: (r) => r.vol >= 2.0 },
    { name: 'fade<=30', fn: (r) => r.fade <= 30 },
    { name: 'fade<=25', fn: (r) => r.fade <= 25 },
    { name: 'fade<=20', fn: (r) => r.fade <= 20 },
    { name: 'rangePos>=0.6', fn: (r) => r.rangePos >= 0.6 },
    { name: 'rangePos>=0.7', fn: (r) => r.rangePos >= 0.7 },
    { name: 'rsi40-65', fn: (r) => r.rsi != null && r.rsi >= 40 && r.rsi <= 65 },
    { name: 'rsi45-60', fn: (r) => r.rsi != null && r.rsi >= 45 && r.rsi <= 60 },
    { name: 'rsi45-62', fn: (r) => r.rsi != null && r.rsi >= 45 && r.rsi <= 62 },
    { name: 'macdH>0', fn: (r) => r.macdH != null && r.macdH > 0 },
    { name: 'macdB>0', fn: (r) => r.macdB > 0 },
    { name: 'stochB>0', fn: (r) => r.stochB > 0 },
    { name: 'sma5>sma20', fn: (r) => r.sma5 != null && r.sma20 != null && r.sma5 > r.sma20 },
    { name: 'atr<=4', fn: (r) => r.atrPct != null && r.atrPct <= 4 },
    { name: 'atr<=5', fn: (r) => r.atrPct != null && r.atrPct <= 5 },
    { name: 'gap>=60', fn: (r) => r.gap >= 60 },
    { name: 'gap>=70', fn: (r) => r.gap >= 70 },
    { name: 'chg2-8', fn: (r) => r.changePct >= 2 && r.changePct <= 8 },
    { name: 'chg3-6', fn: (r) => r.changePct >= 3 && r.changePct <= 6 },
    { name: 'chg4-7', fn: (r) => r.changePct >= 4 && r.changePct <= 7 },
    { name: 'liq>=55', fn: (r) => r.liq >= 55 },
    { name: 'volC>=55', fn: (r) => r.volC >= 55 },
  ];

  for (const f of filters) {
    const subset = buys.filter(f.fn);
    if (subset.length < 10) continue;
    const wins = subset.filter((r) => r.win5).length;
    const wr = wins / subset.length * 100;
    const avgMax = subset.filter((r) => r.max5 != null).reduce((a, r) => a + r.max5, 0) / subset.filter((r) => r.max5 != null).length;
    if (wr >= 70) console.log(`${f.name.padEnd(14)} n=${subset.length.toString().padStart(5)}  max5dWin=${wr.toFixed(1).padStart(5)}%  avgMax=${avgMax.toFixed(2)}%`);
  }

  // Greedy combination search
  console.log('\n--- GREEDY COMBINATION SEARCH (target: 80% max5d) ---');
  let current = buys;
  const used = [];
  for (let iter = 0; iter < 10; iter++) {
    let best = null;
    for (const f of filters) {
      if (used.includes(f.name)) continue;
      const subset = current.filter(f.fn);
      if (subset.length < 5) continue;
      const wins = subset.filter((r) => r.win5).length;
      const wr = wins / subset.length * 100;
      const avgMax = subset.filter((r) => r.max5 != null).reduce((a, r) => a + r.max5, 0) / subset.filter((r) => r.max5 != null).length;
      const score = wr + Math.min(subset.length / 30, 5);
      if (!best || score > best.score) best = { name: f.name, subset, wr, n: subset.length, avgMax };
    }
    if (!best) break;
    used.push(best.name);
    current = best.subset;
    console.log(`step${iter + 1}: +${best.name}  n=${best.n}  max5dWin=${best.wr.toFixed(1)}%  avgMax=${best.avgMax.toFixed(2)}%`);
    if (best.wr >= 80 && best.n >= 5) { console.log('  >>> REACHED 80%! <<<'); break; }
  }

  console.log('\nFinal combination:', used.join(' + '));
  console.log(`Final n=${current.length}, max5dWin=${(current.filter((r) => r.win5).length / current.length * 100).toFixed(1)}%`);
}

run().catch((e) => { console.error(e); process.exit(1); });
