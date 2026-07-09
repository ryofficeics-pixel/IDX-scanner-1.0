'use strict';

const { generateSignal } = require('../lib/engine/signalEngine');
const { getUniverse } = require('../lib/market/idxUniverse');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
          open: ohlc.open?.[i],
          high: ohlc.high?.[i],
          low: ohlc.low?.[i],
          close: ohlc.close?.[i],
          volume: ohlc.volume?.[i],
          adjclose: adjclose[i] || ohlc.close?.[i],
        });
      }
      const valid = candles.filter((c) => num(c.close) != null);
      if (valid.length >= 220) results[symbol] = valid;
    } catch { }
  }
  return results;
}

// Swing-trade exit model: buy at close, target +T%, stop -S%, max hold N days.
// Returns { win, exitReturn, exitDay, reason } where reason is 'target'|'stop'|'hold'.
function swingExit(close, future, target = 0.03, stop = 0.02, holdDays = 5) {
  if (!future || future.length === 0) return { win: null, exitReturn: null, exitDay: null, reason: 'no-data' };
  for (let i = 0; i < Math.min(holdDays, future.length); i++) {
    const hi = num(future[i].high);
    const lo = num(future[i].low);
    const c = num(future[i].close);
    if (hi != null && hi >= close * (1 + target)) {
      return { win: true, exitReturn: target * 100, exitDay: i + 1, reason: 'target' };
    }
    if (lo != null && lo <= close * (1 - stop)) {
      const r = (lo / close - 1) * 100;
      return { win: false, exitReturn: r, exitDay: i + 1, reason: 'stop' };
    }
  }
  const lastClose = num(future[Math.min(holdDays, future.length) - 1].close);
  if (lastClose == null) return { win: null, exitReturn: null, exitDay: null, reason: 'no-data' };
  const r = (lastClose / close - 1) * 100;
  return { win: r > 0, exitReturn: r, exitDay: Math.min(holdDays, future.length), reason: 'hold' };
}

async function runBacktest() {
  console.log('=== IDX Scanner 2-Year Backtest — 5-Day Swing Win Rate ===\n');
  const universe = getUniverse({});
  const allSymbols = universe.map((r) => r.symbol);
  console.log(`Universe: ${allSymbols.length} symbols\nFetching daily charts...\n`);

  const charts = await fetchDailyCharts(['^JKSE', ...allSymbols], 2);
  delete charts['^JKSE'];
  const symbols = Object.keys(charts).sort();
  console.log(`Analyzing ${symbols.length} stocks over ~2 years...\n`);

  const START_DAYS = 220;
  const signals = [];

  for (const symbol of symbols) {
    const candles = charts[symbol];
    if (!candles || candles.length < START_DAYS + 6) continue;

    for (let d = START_DAYS; d < candles.length - 6; d++) {
      const today = candles[d];
      const prev = candles[d - 1];
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
        symbol, yahooSymbol: `${symbol}.JK`, name: symbol,
        lastPrice: close, previousClose: prevClose,
        dayHigh: high, dayLow: low, volume, avgVolume20,
        changePct: prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0,
        timestamp: today.timestamp, marketState: 'REGULAR', source: 'yahoo-finance',
      };

      const ihsgCloses = charts['^JKSE'] ? charts['^JKSE'].slice(0, d + 1).map((c) => num(c.close)).filter((v) => v != null) : [];
      const ihsgChangePct = ihsgCloses.length >= 2 && ihsgCloses[ihsgCloses.length - 2] > 0
        ? ((ihsgCloses[ihsgCloses.length - 1] - ihsgCloses[ihsgCloses.length - 2]) / ihsgCloses[ihsgCloses.length - 2]) * 100 : 0;
      const ihsgPrice = ihsgCloses.length ? ihsgCloses[ihsgCloses.length - 1] : null;
      const ihsgSma20 = ihsgCloses.length >= 20 ? ihsgCloses.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
      const ihsgSma5 = ihsgCloses.length >= 5 ? ihsgCloses.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;

      const marketContext = { ihsgChangePct, ihsgPrice, ihsgSma20, ihsgSma5 };
      const sessionStub = { status: 'AFTERNOON', sessionProgress: 0.85, expectedVolumeProgress: 0.75, timezone: 'Asia/Jakarta' };
      const histories = {
        daily: dailyHistory,
        intraday: [{ open, high, low, close, volume }],
        now: new Date(today.timestamp),
      };

      const sig = generateSignal(stock, marketContext, sessionStub, histories);
      if (sig.action !== 'BUY' && sig.action !== 'STRONG_BUY' && sig.action !== 'HIGH_CONFIDENCE_BUY') continue;

      const future = candles.slice(d + 1, d + 1 + 5);
      const swing = swingExit(close, future, 0.03, 0.02, 5);

      const fwd1 = candles[d + 1] ? num(candles[d + 1].close) : null;
      const fwd3 = candles[d + 3] ? num(candles[d + 3].close) : null;
      const fwd5 = candles[d + 5] ? num(candles[d + 5].close) : null;
      const maxRet5 = Math.max(
        ...[1, 2, 3, 4, 5].map((k) => candles[d + k] ? (num(candles[d + k].close) - close) / close * 100 : -Infinity)
      );
      const minRet5 = Math.min(
        ...[1, 2, 3, 4, 5].map((k) => candles[d + k] ? (num(candles[d + k].close) - close) / close * 100 : Infinity)
      );

      signals.push({
        symbol, action: sig.action, score: sig.score, changePct: sig.changePct,
        swingWin: swing.win, swingReason: swing.reason, swingReturn: swing.exitReturn, swingDay: swing.exitDay,
        fwd1: fwd1 ? (fwd1 - close) / close * 100 : null,
        fwd3: fwd3 ? (fwd3 - close) / close * 100 : null,
        fwd5: fwd5 ? (fwd5 - close) / close * 100 : null,
        maxRet5: maxRet5 === -Infinity ? null : maxRet5,
        minRet5: minRet5 === Infinity ? null : minRet5,
      });
    }
  }

  // Report
  const n = signals.length;
  console.log(`Total BUY/STRONG_BUY signals: ${n}\n`);

  const byAction = {};
  for (const s of signals) {
    byAction[s.action] = byAction[s.action] || [];
    byAction[s.action].push(s);
  }

  console.log('--- WIN RATE BY METRIC ---');
  function reportMet(sig, label) {
    if (!sig.length) return;
    const sw = sig.filter((x) => x.swingWin === true).length;
    const swN = sig.filter((x) => x.swingWin != null).length;
    const d1 = sig.filter((x) => x.fwd1 != null && x.fwd1 > 0).length;
    const d1N = sig.filter((x) => x.fwd1 != null).length;
    const d3 = sig.filter((x) => x.fwd3 != null && x.fwd3 > 0).length;
    const d3N = sig.filter((x) => x.fwd3 != null).length;
    const d5 = sig.filter((x) => x.fwd5 != null && x.fwd5 > 0).length;
    const d5N = sig.filter((x) => x.fwd5 != null).length;
    const max5 = sig.filter((x) => x.maxRet5 != null && x.maxRet5 > 0).length;
    const max5N = sig.filter((x) => x.maxRet5 != null).length;
    const avgSwing = sig.filter((x) => x.swingReturn != null).reduce((a, x) => a + x.swingReturn, 0) / sig.filter((x) => x.swingReturn != null).length;
    console.log(`${label.padEnd(14)} n=${sig.length.toString().padStart(5)}  ` +
      `swing5d=${(swN ? (sw / swN * 100).toFixed(1) : '-').padStart(5)}%  ` +
      `1d=${(d1N ? (d1 / d1N * 100).toFixed(1) : '-').padStart(5)}%  ` +
      `3d=${(d3N ? (d3 / d3N * 100).toFixed(1) : '-').padStart(5)}%  ` +
      `5d=${(d5N ? (d5 / d5N * 100).toFixed(1) : '-').padStart(5)}%  ` +
      `max5d=${(max5N ? (max5 / max5N * 100).toFixed(1) : '-').padStart(5)}%  ` +
      `avgSwing=${avgSwing.toFixed(2)}%`);
  }

  reportMet(signals, 'ALL BUY');
  for (const [action, sig] of Object.entries(byAction)) reportMet(sig, action);

  // Swing reason breakdown
  const reasons = {};
  for (const s of signals) reasons[s.swingReason] = (reasons[s.swingReason] || 0) + 1;
  console.log('\nSwing exit reasons:', JSON.stringify(reasons));

  // Exit day distribution
  const exitDays = {};
  for (const s of signals) exitDays[s.swingDay] = (exitDays[s.swingDay] || 0) + 1;
  console.log('Exit day distribution:', JSON.stringify(exitDays));

  // Score threshold sweep on swing win rate
  console.log('\n--- SCORE THRESHOLD SWEEP (swing5d win rate) ---');
  for (let thresh = 70; thresh <= 95; thresh += 3) {
    const subset = signals.filter((s) => s.score >= thresh);
    if (subset.length < 5) continue;
    const sw = subset.filter((x) => x.swingWin === true).length;
    const swN = subset.filter((x) => x.swingWin != null).length;
    const avg = subset.filter((x) => x.swingReturn != null).reduce((a, x) => a + x.swingReturn, 0) / subset.filter((x) => x.swingReturn != null).length;
    console.log(`score>=${thresh}: n=${subset.length} swingWin=${(swN ? (sw / swN * 100).toFixed(1) : '-').padStart(5)}%  avgSwing=${avg.toFixed(2)}%`);
  }

  console.log('\n================================================');
}

runBacktest().catch((e) => { console.error(e); process.exit(1); });
