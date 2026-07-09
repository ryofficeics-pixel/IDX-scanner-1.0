'use strict';

const { getUniverse } = require('../lib/market/idxUniverse');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function fetchDailyCharts(symbols) {
  const results = {};
  for (const symbol of symbols) {
    const yahooSym = symbol === '^JKSE' ? '^JKSE' : `${symbol}.JK`;
    try {
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=5y&interval=1d`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (IDXScanner/3.0)', Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const timestamps = result.timestamp || [];
      const o = result.indicators?.quote?.[0] || {};
      const a = result.indicators?.adjclose?.[0]?.adjclose || [];
      const c = [];
      for (let i = 0; i < timestamps.length; i++) {
        c.push({ d: timestamps[i] * 1000, o: o.open?.[i], h: o.high?.[i], l: o.low?.[i], c: o.close?.[i], v: o.volume?.[i], a: a[i] || o.close?.[i] });
      }
      const valid = c.filter((x) => num(x.c) != null);
      if (valid.length >= 300) { results[symbol] = valid; }
    } catch { }
  }
  return results;
}

// TA helpers
function sma(vals, n) { if (vals.length < n) return null; let s = 0; for (let i = vals.length - n; i < vals.length; i++) s += vals[i]; return s / n; }
function ema(vals, n) { if (vals.length < n) return null; const k = 2 / (n + 1); let v = sma(vals.slice(0, n), n); for (let i = n; i < vals.length; i++) v = vals[i] * k + v * (1 - k); return v; }
function rsi(vals, n) {
  if (vals.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = vals[i] - vals[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  for (let i = n + 1; i < vals.length; i++) { const d = vals[i] - vals[i - 1]; ag = ((ag * (n - 1)) + Math.max(d, 0)) / n; al = ((al * (n - 1)) + Math.max(-d, 0)) / n; }
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}
function macdV(vals) { if (vals.length < 33) return null; const f = ema(vals, 12), s = ema(vals, 26); if (f == null || s == null) return null; return f - s; }
function macdS(vals) { if (vals.length < 33) return null; const ms = []; for (let i = 26; i <= vals.length; i++) { const f = ema(vals.slice(0, i), 12), s = ema(vals.slice(0, i), 26); if (f != null && s != null) ms.push(f - s); } return ms.length ? ema(ms, 9) : null; }
function atr(c, n) { if (c.length < n + 1) return null; const tr = []; for (let i = 1; i < c.length; i++) { tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c))); } if (tr.length < n) return null; let a = tr.slice(0, n).reduce((s, v) => s + v, 0) / n; for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a; }

class FeatureEngine {
  extract(candles, idx) {
    const c = candles.slice(0, idx + 1);
    const cur = candles[idx];
    const prev = candles[idx - 1] || cur;

    const cl = c.map((x) => x.c);
    const hi = c.map((x) => x.h);
    const lo = c.map((x) => x.l);
    const vo = c.map((x) => x.v);

    const close = num(cur.c);
    const open = num(cur.o) || close;
    const high = num(cur.h) || close;
    const low = num(cur.l) || close;
    const volume = num(cur.v) || 0;
    const prevClose = num(prev.c) || close;
    const changePct = prevClose > 0 ? (close - prevClose) / prevClose * 100 : 0;

    const avgVol = vo.length >= 20 ? sma(vo.slice(-20), 20) : null;
    const volRatio = avgVol && avgVol > 0 ? volume / avgVol : 0;
    const sma5 = sma(cl, 5);
    const sma20 = sma(cl, 20);
    const sma50 = sma(cl, 50);
    const rsi14 = rsi(cl, 14);
    const rsi7 = rsi(cl, 7);
    const macdVLine = macdV(cl);
    const macdSLine = macdS(cl);
    const macdHist = macdVLine != null && macdSLine != null ? macdVLine - macdSLine : null;
    const atr14 = atr(c, 14);
    const atrPct = atr14 != null && close > 0 ? atr14 / close * 100 : null;
    const high20 = Math.max(...hi.slice(-20));
    const low20 = Math.min(...lo.slice(-20));
    const bbMid = sma20;
    const hi20_ = Math.max(...hi.slice(-20));
    const lo20_ = Math.min(...lo.slice(-20));
    const stoK = hi20_ > lo20_ ? (close - lo20_) / (hi20_ - lo20_) * 100 : 50;
    const rangePos = high > low ? (close - low) / (high - low) : 0.5;
    const lateFade = high > low ? (high - close) / (high - low) * 100 : 0;
    const dayRangePct = high > low && close > 0 ? (high - low) / close * 100 : 0;
    const excessRange = Math.max(0, dayRangePct - Math.abs(changePct));
    const breakout = close >= high20 * 0.99;
    const nearLow = close <= low20 * 1.02;

    const sma5_slope = cl.length >= 10 ? (sma(cl.slice(-5), 5) - sma(cl.slice(-10, -5), 5)) / sma(cl.slice(-10, -5), 5) * 100 : 0;

    return {
      close, open, high, low, volume, changePct, volRatio, sma5, sma20, sma50,
      rsi14, rsi7, macdVLine, macdSLine, macdHist, atrPct, bbMid,
      stoK, rangePos, lateFade, dayRangePct, excessRange,
      breakout, nearLow, sma5_slope,
      priceAboveSma5: close > sma5, priceAboveSma20: close > sma20,
      sma5AboveSma20: sma5 != null && sma20 != null && sma5 > sma20,
    };
  }
}

async function run() {
  console.log('=== ULTIMATE WIN RATE OPTIMIZER ===\n');
  const universe = getUniverse({});
  const allSymbols = universe.map((r) => r.symbol);
  console.log(`Fetching ${allSymbols.length} symbols + ^JKSE...`);

  const charts = await fetchDailyCharts(['^JKSE', ...allSymbols]);
  const ihsg = charts['^JKSE'] || [];
  delete charts['^JKSE'];
  const symbols = Object.keys(charts).sort();
  console.log(`Got ${symbols.length} stocks\n`);

  const fe = new FeatureEngine();
  const DAYS = 220;
  const records = [];

  for (const sym of symbols) {
    const c = charts[sym];
    if (!c || c.length < DAYS + 10) continue;

    for (let d = DAYS; d < c.length - 10; d++) {
      const f = fe.extract(c, d);
      const fwd1 = num(c[d + 1].c);
      const fwd3 = num(c[d + 3].c);
      const fwd5 = num(c[d + 5].c);
      const fwd10 = num(c[d + 10].c);

      // Also check trailing stop win: buy at close, sell at first touch of +3% or -2% within 5 days
      let tsWin = null, tsRet = null;
      for (let i = 1; i <= 5 && d + i < c.length; i++) {
        const dayHi = num(c[d + i].h);
        const dayLo = num(c[d + i].l);
        if (dayHi != null && dayHi >= f.close * 1.03) { tsWin = true; tsRet = 3; break; }
        if (dayLo != null && dayLo <= f.close * 0.98) { tsWin = false; tsRet = (dayLo / f.close * 100) - 100; break; }
      }
      if (tsWin == null && fwd5 != null) { tsWin = fwd5 > f.close; tsRet = (fwd5 - f.close) / f.close * 100; }

      records.push({ sym, d, f, fwd1, fwd3, fwd5, fwd10, tsWin, tsRet });
    }
  }

  // Now define strategy functions to test
  const strategies = [];

  // Strategy 1: Original BUY gates simplified
  strategies.push({
    name: 'ORIGINAL_BUY',
    fn: (f) => f.changePct >= 0.5 && f.changePct <= 25 && f.volRatio >= 1.0 && f.rangePos >= 0.50 && f.lateFade <= 50 && f.priceAboveSma5
  });

  // Strategy 2: Strong trend continuation
  strategies.push({
    name: 'TREND_CONT',
    fn: (f) => f.changePct >= 2 && f.changePct <= 9 && f.sma5AboveSma20 && f.priceAboveSma5 && f.volRatio >= 1.2 && f.rangePos >= 0.55 && f.rsi14 != null && f.rsi14 >= 40 && f.rsi14 <= 65
  });

  // Strategy 3: Breakout + volume
  strategies.push({
    name: 'BREAKOUT_HI',
    fn: (f) => f.breakout && f.volRatio >= 1.5 && f.changePct >= 1 && f.changePct <= 8 && f.rangePos >= 0.6 && f.rsi14 != null && f.rsi14 >= 35 && f.rsi14 <= 65 && f.sma5AboveSma20
  });

  // Strategy 4: Momentum acceleration (big move + volume)
  strategies.push({
    name: 'MOMENTUM',
    fn: (f) => f.changePct >= 4 && f.changePct <= 10 && f.volRatio >= 1.3 && f.rsi14 != null && f.rsi14 >= 45 && f.rsi14 <= 68 && f.sma5AboveSma20 && f.lateFade <= 40
  });

  // Strategy 5: Oversold bounce
  strategies.push({
    name: 'OVERSOLD_BOUNCE',
    fn: (f) => f.rsi14 != null && f.rsi14 <= 30 && f.nearLow && f.volRatio >= 0.8 && f.changePct >= -8 && f.changePct <= -1 && f.sma5 != null && f.sma20 != null
  });

  // Strategy 6: RSI + MACD + volume combo
  strategies.push({
    name: 'TA_COMBO',
    fn: (f) => f.rsi14 != null && f.rsi14 >= 40 && f.rsi14 <= 60 && f.macdHist != null && f.macdHist > 0 && f.volRatio >= 1.2 && f.changePct >= 1 && f.changePct <= 8 && f.rangePos >= 0.6 && f.fwd1 != null
  });

  // Strategy 7: Gap-and-go (open higher than previous close, continues)
  strategies.push({
    name: 'GAP_GO',
    fn: (f) => f.open > f.close * 1.01 && f.close > f.open && f.changePct >= 2 && f.changePct <= 7 && f.volRatio >= 1.5 && f.rangePos >= 0.65 && f.rsi14 != null && f.rsi14 >= 40 && f.rsi14 <= 60
  });

  // Strategy 8: High volume close near high
  strategies.push({
    name: 'VOL_SURGE',
    fn: (f) => f.volRatio >= 2.0 && f.rangePos >= 0.7 && f.changePct >= 1 && f.changePct <= 6 && f.lateFade <= 20 && f.rsi14 != null && f.rsi14 >= 35 && f.rsi14 <= 60
  });

  // Strategy 9: Multi-confluence (all good things together)
  strategies.push({
    name: 'CONFLUENCE',
    fn: (f) => f.changePct >= 2 && f.changePct <= 7 && f.volRatio >= 1.5 && f.rangePos >= 0.65 && f.lateFade <= 20 && f.sma5AboveSma20 && f.priceAboveSma20 && f.rsi14 != null && f.rsi14 >= 40 && f.rsi14 <= 60 && f.macdHist != null && f.macdHist > 0
  });

  // Strategy 10: LOW volatility breakout (Bollinger squeeze style)
  strategies.push({
    name: 'LOWVOL_BO',
    fn: (f) => f.atrPct != null && f.atrPct <= 4 && f.changePct >= 2 && f.changePct <= 7 && f.volRatio >= 1.3 && f.rangePos >= 0.6 && f.sma5AboveSma20 && f.rsi14 != null && f.rsi14 >= 40 && f.rsi14 <= 65
  });

  // Strategy 11: Morning star / strong reversal
  strategies.push({
    name: 'REVERSAL',
    fn: (f) => f.changePct >= 1 && f.changePct <= 8 && f.rsi14 != null && f.rsi14 >= 30 && f.rsi14 <= 45 && f.rangePos >= 0.7 && f.volRatio >= 1.3 && f.lateFade <= 20 && f.sma5 != null && f.sma20 != null && f.sma5 > f.sma20
  });

  // Strategy 12: Near 52-week high breakout
  strategies.push({
    name: '52W_HIGH',
    fn: (f) => f.breakout && f.changePct >= 1 && f.changePct <= 5 && f.volRatio >= 1.3 && f.rsi14 != null && f.rsi14 >= 50 && f.rsi14 <= 70 && f.rangePos >= 0.65 && f.lateFade <= 25
  });

  // Strategy 13: Super tight (extreme conditions)
  strategies.push({
    name: 'SUPER_TIGHT',
    fn: (f) => f.changePct >= 3 && f.changePct <= 7 && f.volRatio >= 2.0 && f.rangePos >= 0.7 && f.lateFade <= 15 && f.sma5AboveSma20 && f.rsi14 != null && f.rsi14 >= 45 && f.rsi14 <= 60 && f.macdHist != null && f.macdHist > 0 && f.excessRange <= 5
  });

  // Strategy 14: VWAP-style (price above intraday average, but using daily proxy)
  strategies.push({
    name: 'VWAP_PROXY',
    fn: (f) => f.close > (f.high + f.low + f.close) / 3 && f.changePct >= 1 && f.changePct <= 6 && f.volRatio >= 1.3 && f.rangePos >= 0.6 && f.sma5AboveSma20 && f.rsi14 != null && f.rsi14 >= 40 && f.rsi14 <= 60
  });

  console.log('Testing strategies...\n');

  for (const s of strategies) {
    const filtered = records.filter(s.fn);

    // 1d forward
    const r1d = filtered.map((r) => r.fwd1).filter((v) => v != null);
    const w1d = r1d.filter((v) => v > r1d[0] * 0 || v > 0);
    const w1dCount = r1d.filter((v) => v > 0).length;
    const avg1d = r1d.length ? r1d.reduce((a, b) => a + b, 0) / r1d.length : 0;

    // 3d forward
    const r3d = filtered.map((r) => r.fwd3).filter((v) => v != null);
    const w3d = r3d.filter((v) => v > 0).length;
    const avg3d = r3d.length ? r3d.reduce((a, b) => a + b, 0) / r3d.length : 0;
    const best3d = r3d.length ? Math.max(...r3d) : 0;

    // 5d forward
    const r5d = filtered.map((r) => r.fwd5).filter((v) => v != null);
    const w5d = r5d.filter((v) => v > 0).length;
    const avg5d = r5d.length ? r5d.reduce((a, b) => a + b, 0) / r5d.length : 0;

    // Trailing stop win
    const ts = filtered.filter((r) => r.tsWin != null);
    const tsWins = ts.filter((r) => r.tsWin).length;
    const tsRate = ts.length ? tsWins / ts.length * 100 : 0;
    const tsAvgRet = ts.length ? ts.reduce((a, r) => a + (r.tsRet || 0), 0) / ts.length : 0;

    // Win if within 5d close > entry
    const rAny = filtered.filter((r) => r.fwd1 != null || r.fwd3 != null || r.fwd5 != null);
    const wAny = rAny.filter((r) => {
      const rets = [r.fwd1, r.fwd3, r.fwd5].filter((v) => v != null);
      return rets.length > 0 && Math.max(...rets) > 0;
    }).length;
    const anyWr = rAny.length ? wAny / rAny.length * 100 : 0;

    // Win if ANY of: 1d > 0 OR tsWin OR 5d > 0
    const wCombined = filtered.filter((r) => {
      if (r.tsWin) return true;
      if (r.fwd1 != null && r.fwd1 > 0) return true;
      if (r.fwd5 != null && r.fwd5 > 0) return true;
      return false;
    }).length;
    const combWr = filtered.length ? wCombined / filtered.length * 100 : 0;

    console.log(`${s.name.padEnd(20)} n=${filtered.length.toString().padStart(5)}  ` +
      `1d_wr=${(r1d.length ? (w1dCount/r1d.length*100).toFixed(1) : '-').padStart(5)}  ` +
      `3d_wr=${(r3d.length ? (w3d/r3d.length*100).toFixed(1) : '-').padStart(5)}  ` +
      `5d_wr=${(r5d.length ? (w5d/r5d.length*100).toFixed(1) : '-').padStart(5)}  ` +
      `ts_wr=${(ts.length ? tsRate.toFixed(1) : '-').padStart(5)}  ` +
      `any_wr=${(rAny.length ? anyWr.toFixed(1) : '-').padStart(5)}  ` +
      `comb_wr=${(filtered.length ? combWr.toFixed(1) : '-').padStart(5)}  ` +
      `avg1d=${avg1d.toFixed(2)}%  avg3d=${avg3d.toFixed(2)}%  avg5d=${avg5d.toFixed(2)}%`);
  }

  // Now try parameter sweeps on the best strategy
  console.log('\n--- PARAMETER SWEEP ON CONFLUENCE STRATEGY ---');
  for (let volMin of [1.2, 1.5, 2.0]) {
    for (let rsiLo of [35, 40, 45]) {
      for (let rsiHi of [55, 60, 65]) {
        for (let fadeMax of [15, 20, 25]) {
          for (let chgLo of [1, 2, 3]) {
            for (let chgHi of [5, 6, 7, 8]) {
              const filtered = records.filter((r) => {
                const f = r.f;
                return f.changePct >= chgLo && f.changePct <= chgHi && f.volRatio >= volMin &&
                  f.rangePos >= 0.65 && f.lateFade <= fadeMax && f.sma5AboveSma20 &&
                  f.rsi14 != null && f.rsi14 >= rsiLo && f.rsi14 <= rsiHi &&
                  f.macdHist != null && f.macdHist > 0;
              });
              if (filtered.length < 5) continue;
              // Check comb_wr
              const valid = filtered.filter((r) => r.fwd1 != null || r.fwd5 != null || r.tsWin != null);
              const winners = valid.filter((r) => {
                if (r.tsWin) return true;
                if (r.fwd1 != null && r.fwd1 > 0) return true;
                if (r.fwd5 != null && r.fwd5 > 0) return true;
                return false;
              });
              const wr = valid.length ? winners.length / valid.length * 100 : 0;
              const avg = valid.length ? valid.reduce((a, r) => {
                const rets = [r.fwd1, r.fwd3, r.fwd5].filter((v) => v != null);
                return a + (rets.length ? Math.max(...rets) : 0);
              }, 0) / valid.length : 0;
              if (wr >= 65 && filtered.length >= 5) {
                console.log(`n=${filtered.length} wr=${wr.toFixed(1)}% avg=${avg.toFixed(2)}%  ` +
                  `chg[${chgLo}-${chgHi}] vol>=${volMin} rsi[${rsiLo}-${rsiHi}] fade<=${fadeMax}`);
              }
            }
          }
        }
      }
    }
  }

  // Now try machine learning: find decision boundary for 80% win rate
  console.log('\n--- DECISION TREE APPROACH (greedy threshold search) ---');
  // Find the single best filter and sequentially tighten
  const bestCombos = [];

  // Start with all records, greedily add filters
  let candidates = records.filter((r) => r.fwd1 != null);
  const filters = [
    { name: 'changePct>=2', fn: (r) => r.f.changePct >= 2 },
    { name: 'changePct<=8', fn: (r) => r.f.changePct <= 8 },
    { name: 'volRatio>=1.3', fn: (r) => r.f.volRatio >= 1.3 },
    { name: 'volRatio>=1.5', fn: (r) => r.f.volRatio >= 1.5 },
    { name: 'volRatio>=2.0', fn: (r) => r.f.volRatio >= 2.0 },
    { name: 'rangePos>=0.6', fn: (r) => r.f.rangePos >= 0.6 },
    { name: 'rangePos>=0.7', fn: (r) => r.f.rangePos >= 0.7 },
    { name: 'rangePos>=0.75', fn: (r) => r.f.rangePos >= 0.75 },
    { name: 'lateFade<=30', fn: (r) => r.f.lateFade <= 30 },
    { name: 'lateFade<=20', fn: (r) => r.f.lateFade <= 20 },
    { name: 'lateFade<=15', fn: (r) => r.f.lateFade <= 15 },
    { name: 'lateFade<=10', fn: (r) => r.f.lateFade <= 10 },
    { name: 'sma5>sma20', fn: (r) => r.f.sma5AboveSma20 },
    { name: 'price>sma5', fn: (r) => r.f.priceAboveSma5 },
    { name: 'price>sma20', fn: (r) => r.f.priceAboveSma20 },
    { name: 'breakout', fn: (r) => r.f.breakout },
    { name: 'rsi>=40', fn: (r) => r.f.rsi14 != null && r.f.rsi14 >= 40 },
    { name: 'rsi<=60', fn: (r) => r.f.rsi14 != null && r.f.rsi14 <= 60 },
    { name: 'rsi>=45', fn: (r) => r.f.rsi14 != null && r.f.rsi14 >= 45 },
    { name: 'rsi<=55', fn: (r) => r.f.rsi14 != null && r.f.rsi14 <= 55 },
    { name: 'rsi>=50', fn: (r) => r.f.rsi14 != null && r.f.rsi14 >= 50 },
    { name: 'rsi<=65', fn: (r) => r.f.rsi14 != null && r.f.rsi14 <= 65 },
    { name: 'rsi<=70', fn: (r) => r.f.rsi14 != null && r.f.rsi14 <= 70 },
    { name: 'macdHist>0', fn: (r) => r.f.macdHist != null && r.f.macdHist > 0 },
    { name: 'excessRange<=5', fn: (r) => r.f.excessRange <= 5 },
    { name: 'excessRange<=3', fn: (r) => r.f.excessRange <= 3 },
    { name: 'atrPct<=4', fn: (r) => r.f.atrPct != null && r.f.atrPct <= 4 },
    { name: 'atrPct<=3', fn: (r) => r.f.atrPct != null && r.f.atrPct <= 3 },
    { name: 'stoK>=60', fn: (r) => r.f.stoK >= 60 },
    { name: 'stoK>=70', fn: (r) => r.f.stoK >= 70 },
    { name: 'dayRange<=8', fn: (r) => r.f.dayRangePct <= 8 },
    { name: 'chg>=3', fn: (r) => r.f.changePct >= 3 },
    { name: 'chg<=6', fn: (r) => r.f.changePct <= 6 },
    { name: 'chg>=4', fn: (r) => r.f.changePct >= 4 },
    { name: 'chg<=7', fn: (r) => r.f.changePct <= 7 },
    { name: 'chg<=9', fn: (r) => r.f.changePct <= 9 },
  ];

  // Greedy addition
  const usedFilters = [];
  let current = [...records];
  let lastWR = 0;

  for (let iter = 0; iter < 15; iter++) {
    let best = null;
    let bestCandidate = null;

    for (const filter of filters) {
      if (usedFilters.includes(filter.name)) continue;
      const subset = current.filter(filter.fn);
      if (subset.length < 3) continue;

      // Calculate combined win rate (1d OR ts OR 5d)
      const w = subset.filter((r) => {
        if (r.tsWin) return true;
        if (r.fwd1 != null && r.fwd1 > 0) return true;
        if (r.fwd5 != null && r.fwd5 > 0) return true;
        return false;
      });
      const wr = subset.length ? w.length / subset.length * 100 : 0;
      const avgRets = subset.reduce((a, r) => {
        const rets = [r.fwd1, r.fwd3, r.fwd5].filter((v) => v != null);
        return a + (rets.length ? Math.max(...rets) : 0);
      }, 0) / subset.length;

      // Score = win rate + bonus for sample size + bonus for avg return
      const score = wr + Math.min(subset.length / 20, 10) + Math.min(Math.max(avgRets, 0) * 3, 10);

      if (!best || score > best) {
        best = score;
        bestCandidate = { name: filter.name, subset, wr, n: subset.length, avgRet: avgRets };
      }
    }

    if (!bestCandidate || bestCandidate.wr < lastWR) break;
    usedFilters.push(bestCandidate.name);
    current = bestCandidate.subset;
    lastWR = bestCandidate.wr;

    // win rates for each metric
    const w1d = current.filter((r) => r.fwd1 != null && r.fwd1 > 0).length;
    const wr1d = current.filter((r) => r.fwd1 != null).length;
    const w5d = current.filter((r) => r.fwd5 != null && r.fwd5 > 0).length;
    const wr5d = current.filter((r) => r.fwd5 != null).length;
    const wts = current.filter((r) => r.tsWin != null && r.tsWin).length;
    const wrts = current.filter((r) => r.tsWin != null).length;

    console.log(`  step${iter + 1}: +${bestCandidate.name}  n=${bestCandidate.n}  ` +
      `cwr=${bestCandidate.wr.toFixed(1)}%  ` +
      `1d=${(wr1d ? (w1d/wr1d*100).toFixed(1) : '-')}%  ` +
      `5d=${(wr5d ? (w5d/wr5d*100).toFixed(1) : '-')}%  ` +
      `ts=${(wrts ? (wts/wrts*100).toFixed(1) : '-')}%  ` +
      `avgRet=${bestCandidate.avgRet.toFixed(2)}%`);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
