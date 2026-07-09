'use strict';

const { generateSignal } = require('../lib/engine/signalEngine');
const { getUniverse } = require('../lib/market/idxUniverse');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function sma(v, n) { if (v.length < n) return null; return v.slice(-n).reduce((a, b) => a + b, 0) / n; }

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
        candles.push({ d: t, o: ohlc.open?.[i], h: ohlc.high?.[i], l: ohlc.low?.[i], c: ohlc.close?.[i], v: ohlc.volume?.[i], a: adjclose[i] || ohlc.close?.[i] });
      }
      const valid = candles.filter((x) => num(x.c) != null);
      if (valid.length >= 220) results[symbol] = valid;
    } catch { }
  }
  return results;
}

async function run() {
  console.log('=== IHSG-TIMED WIN RATE OPTIMIZER ===\n');
  const universe = getUniverse({});
  const allSymbols = universe.map((r) => r.symbol);
  const charts = await fetchDailyCharts(['^JKSE', ...allSymbols], 2);
  const ihsg = charts['^JKSE'] || [];
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
      const open = num(today.o) ?? num(today.c);
      const high = num(today.h) ?? num(today.c);
      const low = num(today.l) ?? num(today.c);
      const close = num(today.c);
      const volume = num(today.v) ?? 0;
      const prevClose = num(prev.c) ?? close;
      if (!close) continue;
      const avgVolumeArr = dailyHistory.slice(-20).map((c) => num(c.v)).filter((v) => v != null);
      const avgVolume20 = avgVolumeArr.length ? avgVolumeArr.reduce((a, b) => a + b, 0) / avgVolumeArr.length : null;
      const stock = {
        symbol, yahooSymbol: `${symbol}.JK`, name: symbol, lastPrice: close, previousClose: prevClose,
        dayHigh: high, dayLow: low, volume, avgVolume20,
        changePct: prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0,
        timestamp: new Date(today.d).toISOString(), marketState: 'REGULAR', source: 'yahoo-finance',
      };

      // IHSG context
      const ihsgCloses = ihsg.length >= d ? ihsg.slice(0, d + 1).map((x) => num(x.c)).filter((v) => v != null) : [];
      const ihsgChangePct = ihsgCloses.length >= 2 && ihsgCloses[ihsgCloses.length - 2] > 0
        ? ((ihsgCloses[ihsgCloses.length - 1] - ihsgCloses[ihsgCloses.length - 2]) / ihsgCloses[ihsgCloses.length - 2]) * 100 : 0;
      const ihsgSma20 = ihsgCloses.length >= 20 ? sma(ihsgCloses, 20) : null;
      const ihsgSma5 = ihsgCloses.length >= 5 ? sma(ihsgCloses, 5) : null;
      const ihsgTrend = (ihsgSma20 != null && ihsgCloses[ihsgCloses.length - 1] > ihsgSma20) ? 1 : 0;
      const ihsgRising = (ihsgSma5 != null && ihsgSma20 != null && ihsgSma5 > ihsgSma20) ? 1 : 0;

      const marketContext = { ihsgChangePct, ihsgSma20, ihsgSma5 };
      const sessionStub = { status: 'AFTERNOON', sessionProgress: 0.85, expectedVolumeProgress: 0.75, timezone: 'Asia/Jakarta' };
      const histories = { daily: dailyHistory, intraday: [{ open, high, low, close, volume }], now: new Date(today.d) };
      const sig = generateSignal(stock, marketContext, sessionStub, histories);
      const ind = sig.indicators;
      const maxRet5 = Math.max(...[1, 2, 3, 4, 5].map((k) => candles[d + k] ? (num(candles[d + k].c) - close) / close * 100 : -Infinity));
      rows.push({
        action: sig.action, category: sig.category, score: sig.score, changePct: sig.changePct,
        win5: maxRet5 != null && maxRet5 > 0, max5: maxRet5,
        dts: ind.dailyTrendScore, brk: ind.breakoutScore, vol: ind.projectedVolRatio,
        fade: ind.lateFadeScore, rsi: ind.rsiDaily, macdH: ind.macdHistogram,
        ihsgTrend, ihsgRising, ihsgChangePct,
      });
    }
  }

  console.log(`Total rows: ${rows.length}`);

  function rep(label, subset) {
    if (subset.length < 5) return;
    const w = subset.filter((r) => r.win5).length;
    const wr = w / subset.length * 100;
    const avg = subset.filter((r) => r.max5 != null).reduce((a, r) => a + r.max5, 0) / subset.filter((r) => r.max5 != null).length;
    console.log(`${label.padEnd(40)} n=${subset.length.toString().padStart(5)}  win5=${wr.toFixed(1).padStart(5)}%  avgMax=${avg.toFixed(2)}%`);
  }

  console.log('\n--- ALL ACTIONS max5d win rate ---');
  rep('ALL', rows);
  for (const action of ['BUY', 'STRONG_BUY', 'WATCH']) rep(action, rows.filter((r) => r.action === action));
  for (const cat of ['ARA_CANDIDATE', 'ACCUMULATION_PROXY', 'EARLY_MOMENTUM', 'MORNING_WATCH', 'BELI_PAGI']) {
    rep(cat, rows.filter((r) => r.category === cat));
  }

  console.log('\n--- IHSG TIMING FILTER ---');
  rep('ihsg uptrend (price>sma20)', rows.filter((r) => r.ihsgTrend === 1));
  rep('ihsg rising (sma5>sma20)', rows.filter((r) => r.ihsgRising === 1));
  rep('ihsg uptrend+rising', rows.filter((r) => r.ihsgTrend === 1 && r.ihsgRising === 1));

  console.log('\n--- IHSG TIMING on BUY/STRONG_BUY ---');
  const buys = rows.filter((r) => r.action === 'BUY' || r.action === 'STRONG_BUY');
  rep('BUY all', buys);
  rep('BUY + ihsg uptrend', buys.filter((r) => r.ihsgTrend === 1));
  rep('BUY + ihsg rising', buys.filter((r) => r.ihsgRising === 1));
  rep('BUY + ihsg uptrend+rising', buys.filter((r) => r.ihsgTrend === 1 && r.ihsgRising === 1));
  rep('BUY + ihsg uptrend+rising + dts>=60', buys.filter((r) => r.ihsgTrend === 1 && r.ihsgRising === 1 && r.dts >= 60));
  rep('BUY + ihsg uptrend+rising + dts>=60 + vol>=1.5', buys.filter((r) => r.ihsgTrend === 1 && r.ihsgRising === 1 && r.dts >= 60 && r.vol >= 1.5));
  rep('BUY + ihsg uptrend+rising + dts>=60 + vol>=1.5 + rsi45-60', buys.filter((r) => r.ihsgTrend === 1 && r.ihsgRising === 1 && r.dts >= 60 && r.vol >= 1.5 && r.rsi != null && r.rsi >= 45 && r.rsi <= 60));

  console.log('\n--- ARA_CANDIDATE with IHSG timing ---');
  const ara = rows.filter((r) => r.category === 'ARA_CANDIDATE');
  rep('ARA all', ara);
  rep('ARA + ihsg uptrend', ara.filter((r) => r.ihsgTrend === 1));
  rep('ARA + ihsg uptrend+rising', ara.filter((r) => r.ihsgTrend === 1 && r.ihsgRising === 1));

  console.log('\n--- EXTREME FILTERS (best case, n>=3) ---');
  function repMin(label, subset, minN = 3) {
    if (subset.length < minN) { console.log(`${label.padEnd(50)} n=${subset.length.toString().padStart(4)} [too small]`); return; }
    const w = subset.filter((r) => r.win5).length;
    const wr = w / subset.length * 100;
    const avg = subset.filter((r) => r.max5 != null).reduce((a, r) => a + r.max5, 0) / subset.filter((r) => r.max5 != null).length;
    console.log(`${label.padEnd(50)} n=${subset.length.toString().padStart(4)}  win5=${wr.toFixed(1).padStart(5)}%  avgMax=${avg.toFixed(2)}%`);
  }
  repMin('STRONG_BUY', rows.filter((r) => r.action === 'STRONG_BUY'));
  repMin('BUY+ihsgUp+ihsgRise+dts>=65+vol>=2+rsi45-60', buys.filter((r) => r.ihsgTrend && r.ihsgRising && r.dts >= 65 && r.vol >= 2 && r.rsi != null && r.rsi >= 45 && r.rsi <= 60));
  repMin('BUY+ihsgUp+ihsgRise+dts>=65+vol>=2+brk>=50', buys.filter((r) => r.ihsgTrend && r.ihsgRising && r.dts >= 65 && r.vol >= 2 && r.brk >= 50));
  repMin('BUY+ihsgUp+ihsgRise+rsi45-60+macdH>0', buys.filter((r) => r.ihsgTrend && r.ihsgRising && r.rsi != null && r.rsi >= 45 && r.rsi <= 60 && r.macdH != null && r.macdH > 0));
  repMin('STRONG_BUY+ihsgUp+ihsgRise', rows.filter((r) => r.action === 'STRONG_BUY' && r.ihsgTrend && r.ihsgRising));
  repMin('STRONG_BUY+ihsgUp+ihsgRise+dts>=65', rows.filter((r) => r.action === 'STRONG_BUY' && r.ihsgTrend && r.ihsgRising && r.dts >= 65));
  repMin('EARLY_MOMENTUM+ihsgUp+ihsgRise', rows.filter((r) => r.category === 'EARLY_MOMENTUM' && r.ihsgTrend && r.ihsgRising));
  repMin('BUY+STRONG+ihsgUp+ihsgRise+dts>=60+vol>=1.5+rsi45-60', rows.filter((r) => (r.action === 'BUY' || r.action === 'STRONG_BUY') && r.ihsgTrend && r.ihsgRising && r.dts >= 60 && r.vol >= 1.5 && r.rsi != null && r.rsi >= 45 && r.rsi <= 60));
}

run().catch((e) => { console.error(e); process.exit(1); });
