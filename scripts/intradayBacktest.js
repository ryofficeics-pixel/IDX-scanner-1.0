'use strict';

const { generateSignal } = require('../lib/engine/signalEngine');
const { getUniverse } = require('../lib/market/idxUniverse');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Fetch real 5-minute bars for a symbol over the last `days` calendar days.
async function fetchIntraday(symbol, days = 60) {
  const yahooSym = `${symbol}.JK`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${days}d&interval=5m`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IDXScanner/3.0)', Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) return null;
      const timestamps = result.timestamp || [];
      const ohlc = result.indicators?.quote?.[0] || {};
      const bars = [];
      for (let i = 0; i < timestamps.length; i++) {
        bars.push({
          timestamp: new Date(timestamps[i] * 1000).toISOString(),
          open: num(ohlc.open?.[i]), high: num(ohlc.high?.[i]),
          low: num(ohlc.low?.[i]), close: num(ohlc.close?.[i]), volume: num(ohlc.volume?.[i]),
        });
      }
      return bars.filter((b) => b.close != null);
    } catch { }
  }
  return null;
}

// Group 5-min bars by trading day (Asia/Jakarta)
function groupByDay(bars) {
  const days = new Map();
  for (const b of bars) {
    const d = new Date(b.timestamp);
    const key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(b);
  }
  return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// Build daily candles from 5-min bars (for the `daily` history input)
function dailyFromIntraday(dayGroups, upToIdx) {
  const daily = [];
  for (let i = 0; i < upToIdx && i < dayGroups.length; i++) {
    const bars = dayGroups[i][1];
    if (!bars.length) continue;
    const opens = bars[0].open;
    const closes = bars[bars.length - 1].close;
    const highs = Math.max(...bars.map((b) => b.high).filter((v) => v != null));
    const lows = Math.min(...bars.map((b) => b.low).filter((v) => v != null));
    const vols = bars.reduce((s, b) => s + (b.volume || 0), 0);
    daily.push({ date: dayGroups[i][0], open: opens, high: highs, low: lows, close: closes, volume: vols });
  }
  return daily;
}

async function run() {
  console.log('=== INTRADAY BACKTEST — Real 5-min Bars ===\n');
  const universe = getUniverse({});
  // Top 20 by liquidity proxy (largest market-cap names)
  const top20 = universe.slice(0, 20).map((r) => r.symbol);
  console.log(`Fetching 5-min bars for ${top20.length} stocks (last 60 days)...\n`);

  const stockData = {};
  for (const sym of top20) {
    const bars = await fetchIntraday(sym, 60);
    if (bars && bars.length > 100) {
      stockData[sym] = groupByDay(bars);
      process.stdout.write(`  ${sym}: ${stockData[sym].length} days OK\n`);
    } else {
      console.warn(`  ${sym}: failed`);
    }
  }

  const symbols = Object.keys(stockData).sort();
  console.log(`\nBacktesting ${symbols.length} stocks with REAL intraday data...\n`);

  const signals = [];
  const START = 20; // need ~20 days of daily history

  for (const sym of symbols) {
    const dayGroups = stockData[sym];
    if (dayGroups.length < START + 2) continue;
    for (let d = START; d < dayGroups.length - 1; d++) {
      const todayBars = dayGroups[d][1];
      if (todayBars.length < 10) continue;
      const lastBar = todayBars[todayBars.length - 1];
      const open = todayBars[0].open;
      const high = Math.max(...todayBars.map((b) => b.high).filter((v) => v != null));
      const low = Math.min(...todayBars.map((b) => b.low).filter((v) => v != null));
      const close = lastBar.close;
      const volume = todayBars.reduce((s, b) => s + (b.volume || 0), 0);
      const prevClose = dayGroups[d - 1][1][dayGroups[d - 1][1].length - 1].close;

      const dailyHistory = dailyFromIntraday(dayGroups, d);
      const avgVol = dailyHistory.slice(-20).map((c) => c.volume).filter((v) => v != null);
      const avgVolume20 = avgVol.length ? avgVol.reduce((a, b) => a + b, 0) / avgVol.length : null;

      const stock = {
        symbol: sym, yahooSymbol: `${sym}.JK`, name: sym,
        lastPrice: close, previousClose: prevClose, dayHigh: high, dayLow: low,
        volume, avgVolume20,
        changePct: prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0,
        timestamp: lastBar.timestamp, marketState: 'REGULAR', source: 'yahoo-intraday',
      };

      const marketContext = { ihsgChangePct: 0 };
      const sessionStub = { status: 'AFTERNOON', sessionProgress: 0.9, expectedVolumeProgress: 0.85, timezone: 'Asia/Jakarta' };
      const histories = { daily: dailyHistory, intraday: todayBars, now: new Date(lastBar.timestamp) };

      const sig = generateSignal(stock, marketContext, sessionStub, histories);
      if (sig.action !== 'BUY' && sig.action !== 'STRONG_BUY' && sig.action !== 'HIGH_CONFIDENCE_BUY' && sig.category !== 'EARLY_MOMENTUM' && sig.category !== 'ARA_CANDIDATE') continue;

      // Next-day return
      const nextDay = dayGroups[d + 1] ? dayGroups[d + 1][1] : null;
      if (!nextDay || !nextDay.length) continue;
      const nextClose = nextDay[nextDay.length - 1].close;
      const nextOpen = nextDay[0].open;
      const nextHigh = Math.max(...nextDay.map((b) => b.high).filter((v) => v != null));
      const nextLow = Math.min(...nextDay.map((b) => b.low).filter((v) => v != null));

      // Win definitions
      const win1dClose = nextClose > close;
      const win1dOpen = (nextOpen - close) / close * 100 > 0;
      // Swing: buy at close, target +3%/-2% next day
      let swingWin = null;
      if (nextHigh >= close * 1.03) swingWin = true;
      else if (nextLow <= close * 0.98) swingWin = false;
      else swingWin = nextClose > close;

      const ind = sig.indicators;
      signals.push({
        sym, action: sig.action, category: sig.category, score: sig.score, changePct: sig.changePct,
        win1dClose, win1dOpen, swingWin,
        earlyMom: ind.earlyMomentumScore, accel: ind.acceleration,
        dts: ind.dailyTrendScore, brk: ind.breakoutScore, vol: ind.projectedVolRatio,
        fade: ind.lateFadeScore, rsi: ind.rsiDaily, macdH: ind.macdHistogram,
        rangePos: ind.rangePosition, araProg: ind.araProgressPct,
      });
    }
  }

  const n = signals.length;
  console.log(`Total signals (BUY/STRONG_BUY/EARLY_MOMENTUM/ARA): ${n}\n`);

  function rep(label, subset) {
    if (subset.length < 3) { console.log(`${label.padEnd(35)} n=${subset.length} [too small]`); return; }
    const w1 = subset.filter((s) => s.win1dClose).length / subset.length * 100;
    const wO = subset.filter((s) => s.win1dOpen).length / subset.length * 100;
    const ws = subset.filter((s) => s.swingWin === true).length / subset.filter((s) => s.swingWin != null).length * 100;
    console.log(`${label.padEnd(35)} n=${subset.length.toString().padStart(4)}  1dClose=${w1.toFixed(1).padStart(5)}%  1dOpen=${wO.toFixed(1).padStart(5)}%  swing=${ws.toFixed(1).padStart(5)}%`);
  }

  rep('ALL SIGNALS', signals);
  rep('HIGH_CONFIDENCE_BUY', signals.filter((s) => s.action === 'HIGH_CONFIDENCE_BUY'));
  rep('EARLY_MOMENTUM', signals.filter((s) => s.category === 'EARLY_MOMENTUM'));
  rep('ARA_CANDIDATE', signals.filter((s) => s.category === 'ARA_CANDIDATE'));
  rep('BUY', signals.filter((s) => s.action === 'BUY'));
  rep('STRONG_BUY', signals.filter((s) => s.action === 'STRONG_BUY'));
  rep('EARLY_MOMENTUM+accel>55', signals.filter((s) => s.category === 'EARLY_MOMENTUM' && s.accel > 55));
  rep('EARLY_MOMENTUM+accel>60', signals.filter((s) => s.category === 'EARLY_MOMENTUM' && s.accel > 60));

  // Filter sweep on ARA_CANDIDATE for 1dOpen win rate
  console.log('\n--- ARA_CANDIDATE 1dOpen filter sweep ---');
  const ara = signals.filter((s) => s.category === 'ARA_CANDIDATE');
  const filters = [
    { name: 'accel>55', fn: (s) => s.accel > 55 },
    { name: 'accel>60', fn: (s) => s.accel > 60 },
    { name: 'vol>=1.5', fn: (s) => s.vol >= 1.5 },
    { name: 'vol>=2.0', fn: (s) => s.vol >= 2.0 },
    { name: 'dts>=55', fn: (s) => s.dts >= 55 },
    { name: 'dts>=60', fn: (s) => s.dts >= 60 },
    { name: 'brk>=40', fn: (s) => s.brk >= 40 },
    { name: 'fade<=30', fn: (s) => s.fade <= 30 },
    { name: 'fade<=25', fn: (s) => s.fade <= 25 },
    { name: 'rsi45-65', fn: (s) => s.rsi != null && s.rsi >= 45 && s.rsi <= 65 },
    { name: 'macdH>0', fn: (s) => s.macdH != null && s.macdH > 0 },
    { name: 'rangePos>=0.6', fn: (s) => s.rangePos >= 0.6 },
    { name: 'chg3-7', fn: (s) => s.changePct >= 3 && s.changePct <= 7 },
    { name: 'araProg20-50', fn: (s) => s.araProg >= 20 && s.araProg <= 50 },
  ];
  for (const f of filters) {
    const subset = ara.filter(f.fn);
    if (subset.length < 5) continue;
    const wO = subset.filter((s) => s.win1dOpen).length / subset.length * 100;
    const wC = subset.filter((s) => s.win1dClose).length / subset.length * 100;
    if (wO >= 65) console.log(`  ${f.name.padEnd(16)} n=${subset.length.toString().padStart(4)}  1dOpen=${wO.toFixed(1).padStart(5)}%  1dClose=${wC.toFixed(1).padStart(5)}%`);
  }

  // Greedy combination
  console.log('\n--- GREEDY COMBO (target 80% 1dOpen) ---');
  let current = ara;
  const used = [];
  for (let iter = 0; iter < 8; iter++) {
    let best = null;
    for (const f of filters) {
      if (used.includes(f.name)) continue;
      const subset = current.filter(f.fn);
      if (subset.length < 4) continue;
      const wO = subset.filter((s) => s.win1dOpen).length / subset.length * 100;
      const score = wO + Math.min(subset.length / 10, 5);
      if (!best || score > best.score) best = { name: f.name, subset, wO, n: subset.length };
    }
    if (!best) break;
    used.push(best.name);
    current = best.subset;
    console.log(`  step${iter + 1}: +${best.name}  n=${best.n}  1dOpen=${best.wO.toFixed(1)}%`);
    if (best.wO >= 80 && best.n >= 5) { console.log('  >>> 80% REACHED <<<'); break; }
  }
  console.log(`  Final: ${used.join('+')}  n=${current.length}  1dOpen=${(current.filter((s) => s.win1dOpen).length / current.length * 100).toFixed(1)}%`);

  console.log('\n=============================================');
  console.log('Intraday backtest complete.');
}

run().catch((e) => { console.error(e); process.exit(1); });
