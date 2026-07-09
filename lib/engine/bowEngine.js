'use strict';

const TI = require('technicalindicators');
const { clamp } = require('./indicators');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  const clean = values.map(num).filter((v) => v != null);
  return clean.length ? clean.reduce((sum, v) => sum + v, 0) / clean.length : null;
}

function pct(a, b) {
  a = num(a); b = num(b);
  return a != null && b > 0 ? ((a - b) / b) * 100 : null;
}

function movingAverage(closes, length) {
  if (closes.length < length) return null;
  return avg(closes.slice(-length));
}

function ema(closes, length) {
  if (closes.length < length) return null;
  const k = 2 / (length + 1);
  let value = avg(closes.slice(0, length));
  for (let i = length; i < closes.length; i += 1) value = closes[i] * k + value * (1 - k);
  return value;
}

function rsi(closes, length = 14) {
  if (closes.length < length + 1) return null;
  const r = TI.RSI.calculate({ values: closes, period: length });
  return r.length ? r[r.length - 1] : null;
}

function macd(closes) {
  if (closes.length < 33) return { macd:null, signal:null, histogram:null };
  const r = TI.MACD.calculate({ values: closes, fastPeriod:12, slowPeriod:26, signalPeriod:9 });
  const last = r.length ? r[r.length - 1] : null;
  return last ? { macd:last.MACD, signal:last.signal, histogram:last.histogram } : { macd:null, signal:null, histogram:null };
}

function lowerVolumeOnPullback(candles, swingHighIndex) {
  if (swingHighIndex < 0 || swingHighIndex >= candles.length - 1) return false;
  const before = avg(candles.slice(Math.max(0, swingHighIndex - 10), swingHighIndex + 1).map((c) => c.volume));
  const after = avg(candles.slice(swingHighIndex + 1).map((c) => c.volume));
  return before != null && after != null && after <= before * 0.9;
}

function detectDistribution(candles) {
  const recent = candles.slice(-10);
  let days = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const cur = recent[i];
    if (num(cur.close) < num(prev.close) && num(cur.volume) > num(prev.volume) * 1.25) days += 1;
  }
  return days;
}

function reversalSignals(candles, closes) {
  const out = [];
  const last = candles[candles.length - 1] || {};
  const prev = candles[candles.length - 2] || {};
  const lastOpen = num(last.open);
  const lastClose = num(last.close);
  const lastHigh = num(last.high);
  const lastLow = num(last.low);
  const prevOpen = num(prev.open);
  const prevClose = num(prev.close);
  if (lastOpen != null && lastClose != null && lastHigh != null && lastLow != null) {
    const body = Math.abs(lastClose - lastOpen);
    const lowerWick = Math.min(lastOpen, lastClose) - lastLow;
    if (lastClose >= lastOpen && lowerWick > body * 1.8) out.push('Hammer');
  }
  if (lastOpen != null && lastClose != null && prevOpen != null && prevClose != null && prevClose < prevOpen && lastClose > lastOpen && lastClose >= prevOpen && lastOpen <= prevClose) {
    out.push('Bullish engulfing');
  }
  const m = macd(closes);
  if (m.macd != null && m.signal != null && m.histogram >= 0) out.push('MACD bullish');
  const lows = candles.slice(-12).map((c) => num(c.low)).filter((v) => v != null);
  if (lows.length >= 6 && Math.min(...lows.slice(-5)) > Math.min(...lows.slice(0, -5))) out.push('Higher low');
  return out;
}

function bowCategory(score) {
  if (score >= 90) return 'Strong Buy On Weakness';
  if (score >= 80) return 'Buy Zone';
  if (score >= 70) return 'Watchlist';
  if (score >= 60) return 'Speculative';
  return 'Avoid';
}

function buildEntry(lastPrice, support, swingHigh) {
  if (!(lastPrice > 0) || !(support > 0)) return null;
  const stopLoss = support * 0.95;
  const risk = lastPrice - stopLoss;
  const target1 = swingHigh > lastPrice ? swingHigh : lastPrice + risk * 2;
  const target2 = Math.max(target1, lastPrice + risk * 3);
  return {
    aggressiveEntry:Math.round(support),
    conservativeEntry:Math.round(lastPrice * 1.025),
    stopLoss:Math.round(stopLoss),
    target1:Math.round(target1),
    target2:Math.round(target2),
    riskReward: risk > 0 ? Number(((target1 - lastPrice) / risk).toFixed(2)) : null,
  };
}

function morningBoomScore(stock, daily, bow) {
  const lastCandle = daily.length ? daily[daily.length - 1] : null;
  const todayHigh = num(stock.dayHigh) ?? (lastCandle ? num(lastCandle.high) : null);
  const todayLow = num(stock.dayLow) ?? (lastCandle ? num(lastCandle.low) : null);
  const todayClose = num(stock.lastPrice) ?? (lastCandle ? num(lastCandle.close) : null);
  const todayVolume = num(stock.volume) ?? (lastCandle ? num(lastCandle.volume) : null);
  const avgVol = num(stock.avgVolume20) ?? avg(daily.slice(-20).map((c) => c.volume));
  let score = 0;
  const factors = [];

  // 1. Range position — close near top carries momentum (0-30 pts)
  const rangePos = todayHigh != null && todayLow != null && todayClose != null && todayHigh > todayLow
    ? (todayClose - todayLow) / (todayHigh - todayLow) : null;
  if (rangePos != null) {
    if (rangePos >= 0.85) { score += 30; factors.push('close near high (range top)'); }
    else if (rangePos >= 0.70) { score += 20; factors.push('close in upper range'); }
    else if (rangePos >= 0.50) { score += 10; factors.push('close mid-range'); }
    else { score += 5; factors.push('close in lower range'); }
  }

  // 2. Volume surge — institutional interest (0-25 pts)
  if (avgVol > 0 && todayVolume != null) {
    const vr = todayVolume / avgVol;
    if (vr >= 2.0) { score += 25; factors.push('volume 2x+ avg'); }
    else if (vr >= 1.5) { score += 18; factors.push('volume 1.5x avg'); }
    else if (vr >= 1.2) { score += 12; factors.push('volume di atas rata-rata'); }
    else { score += 5; }
  }

  // 3. Foreign flow — smart money (0-15 pts)
  const netForeign = num(stock.netBuy);
  if (netForeign != null) {
    if (netForeign > 5e9) { score += 15; factors.push('foreign net buy > Rp5B'); }
    else if (netForeign > 1e9) { score += 10; factors.push('foreign net buy > Rp1B'); }
    else if (netForeign > 0) { score += 5; factors.push('foreign net buy positif'); }
  }

  // 4. Reversal signals (0-15 pts)
  const revCount = (bow.signals || []).length;
  if (revCount >= 2) { score += 15; factors.push(`${revCount} reversal signals`); }
  else if (revCount === 1) { score += 8; factors.push('1 reversal signal'); }

  // 5. BOW setup strength (0-15 pts)
  if (bow.healthyPullback && bow.trendOk) { score += 15; factors.push('BOW setup klasik'); }
  else if (bow.score >= 70) { score += 8; factors.push('BOW watchlist'); }

  const category = score >= 80 ? 'Very High'
    : score >= 65 ? 'High'
    : score >= 50 ? 'Moderate'
    : 'Low';
  return { score, category, factors, rangePosition: rangePos };
}

function generateBowSignal(stock, marketContext = {}, histories = {}) {
  const daily = (histories.daily || []).filter((c) => num(c.close) != null);
  const closes = daily.map((c) => num(c.close));
  const reasons = [];
  const risks = [];
  const rejectReasons = [];
  const lastPrice = num(stock.lastPrice) ?? closes[closes.length - 1];
  const avgVolume20 = num(stock.avgVolume20) ?? avg(daily.slice(-20).map((c) => c.volume));
  const tradedValue20 = lastPrice != null && avgVolume20 != null ? lastPrice * avgVolume20 : null;

  if (lastPrice == null || daily.length < 80) rejectReasons.push('Riwayat harga tidak cukup untuk BOW');
  if (tradedValue20 != null && tradedValue20 < 1e10) rejectReasons.push('Average value traded 20 hari di bawah Rp10 miliar');
  if (num(stock.marketCap) != null && num(stock.marketCap) < 1e12) rejectReasons.push('Market cap di bawah Rp1 triliun');
  if (num(stock.marketCap) == null) risks.push('Market cap tidak tersedia dari provider');

  const ma20 = movingAverage(closes, 20);
  const ma50 = movingAverage(closes, 50);
  const ma200 = movingAverage(closes, 200);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiDaily = rsi(closes, 14);
  const weeklyCloses = [];
  for (let i = 4; i < closes.length; i += 5) weeklyCloses.push(closes[i]);
  const rsiWeekly = rsi(weeklyCloses, 14);
  const high52 = daily.length ? Math.max(...daily.slice(-252).map((c) => num(c.high) ?? num(c.close)).filter((v) => v != null)) : null;
  const recent = daily.slice(-63);
  const recentHigh = recent.length ? Math.max(...recent.map((c) => num(c.high) ?? num(c.close)).filter((v) => v != null)) : null;
  const swingHighIndex = recent.findIndex((c) => (num(c.high) ?? num(c.close)) === recentHigh);
  const pullbackPct = recentHigh && lastPrice ? ((recentHigh - lastPrice) / recentHigh) * 100 : null;
  const below52HighPct = high52 && lastPrice ? ((high52 - lastPrice) / high52) * 100 : null;

  const trendOk = lastPrice > ma200 && ma50 > ma200 && (rsiWeekly == null || rsiWeekly > 45) && (below52HighPct == null || below52HighPct <= 20);
  if (!trendOk) rejectReasons.push('Trend wajib gagal: close/MA50/MA200/RSI weekly/52-week high tidak memenuhi');
  const healthyPullback = pullbackPct != null && pullbackPct >= 5 && pullbackPct <= 20 && rsiDaily != null && rsiDaily >= 30 && rsiDaily <= 50;
  const fallingKnife = (pullbackPct != null && pullbackPct > 30) || (rsiDaily != null && rsiDaily < 25);
  if (fallingKnife) rejectReasons.push('Falling Knife: koreksi ekstrem atau RSI sangat rendah');
  if (!healthyPullback && !fallingKnife) risks.push('Pullback belum masuk zona sehat 5-20% dengan RSI 30-50');

  const nearEma20 = ema20 && lastPrice ? Math.abs(lastPrice - ema20) / ema20 <= 0.035 : false;
  const nearEma50 = ema50 && lastPrice ? Math.abs(lastPrice - ema50) / ema50 <= 0.05 : false;
  const fibZone = pullbackPct != null && pullbackPct >= 7.6 && pullbackPct <= 15.5;
  const distributionDays = detectDistribution(daily);
  if (distributionDays >= 3) rejectReasons.push('Reject candidate: distribution days berturut-turut');
  const volumeConstructive = lowerVolumeOnPullback(recent, swingHighIndex) || distributionDays <= 1;

  const stockReturn3M = closes.length > 63 && lastPrice ? pct(lastPrice, closes[closes.length - 64]) : null;
  const ihsgReturn3M = num(marketContext.ihsgReturn3M);
  const relativeStrength = stockReturn3M != null && ihsgReturn3M != null && Math.abs(ihsgReturn3M) > 0.01 ? stockReturn3M / ihsgReturn3M : null;
  if (relativeStrength != null && relativeStrength <= 1) risks.push('Relative strength 3M belum mengungguli IHSG');
  if (relativeStrength == null) risks.push('Relative strength vs IHSG terbatas karena benchmark history tidak lengkap');

  const reversals = reversalSignals(daily, closes);
  const valuationSignals = [];
  const pe = num(stock.trailingPE) ?? num(stock.forwardPE);
  const pbv = num(stock.priceToBook);
  if (pe != null && pe > 0 && pe <= 18) valuationSignals.push('PER wajar');
  if (pbv != null && pbv > 0 && pbv <= 2.5) valuationSignals.push('PBV wajar');
  if (pe == null && pbv == null) risks.push('Data PER/PBV industri tidak tersedia; valuasi tidak diberi skor penuh');

  if (trendOk) reasons.push('Uptrend jangka panjang masih utuh');
  if (healthyPullback) reasons.push(`Koreksi sehat ${pullbackPct.toFixed(1)}% dari swing high`);
  if (nearEma20 || nearEma50) reasons.push(`Harga dekat ${nearEma20 ? 'EMA20' : 'EMA50'}`);
  if (fibZone) reasons.push('Pullback berada di zona Fibonacci proxy 38.2%-61.8%');
  if (volumeConstructive) reasons.push('Volume pullback tidak menunjukkan distribusi berat');
  if (relativeStrength != null && relativeStrength > 1) reasons.push('Relative strength 3M lebih baik dari IHSG');
  if (valuationSignals.length) reasons.push(valuationSignals.join(', '));
  if (reversals.length >= 2) reasons.push(`Reversal terdeteksi: ${reversals.slice(0, 3).join(', ')}`);

  const trendScore = trendOk ? clamp(70 + (lastPrice > ma50 ? 12 : 0) + (below52HighPct != null ? (20 - below52HighPct) : 0)) : 0;
  const fundamentalScore = clamp((num(stock.marketCap) >= 1e12 ? 35 : 15) + (pe != null && pe > 0 ? 25 : 0) + (pbv != null && pbv > 0 ? 20 : 0) + (num(stock.epsTrailingTwelveMonths) > 0 ? 20 : 0), 0, pe == null && pbv == null ? 45 : 100);
  const pullbackScore = healthyPullback ? clamp(100 - Math.abs((pullbackPct || 0) - 10) * 3 + (nearEma20 || nearEma50 ? 10 : 0) + (fibZone ? 8 : 0)) : fallingKnife ? 0 : 45;
  const volumeScore = distributionDays >= 3 ? 0 : clamp((volumeConstructive ? 70 : 45) + Math.max(0, 2 - distributionDays) * 10);
  const rsScore = relativeStrength == null ? 45 : clamp(45 + relativeStrength * 25);
  const valuationScore = valuationSignals.length ? 70 + valuationSignals.length * 12 : 35;
  const momentumScore = clamp(reversals.length * 35);
  let score = Math.round(
    trendScore * 0.25
    + fundamentalScore * 0.20
    + pullbackScore * 0.20
    + volumeScore * 0.15
    + rsScore * 0.10
    + valuationScore * 0.05
    + momentumScore * 0.05
  );
  if (rejectReasons.length) score = Math.min(score, fallingKnife ? 35 : 59);

  const support = [ema20, ema50, ma50].filter((v) => v != null && v < lastPrice).sort((a, b) => b - a)[0] || ema50 || ma50;
  const boom = morningBoomScore(stock, daily, {
    signals: reversals, score, healthyPullback, trendOk,
  });
  const entryModel = buildEntry(lastPrice, support, recentHigh);
  return {
    symbol:stock.symbol,
    yahooSymbol:stock.yahooSymbol,
    name:stock.name || stock.symbol,
    lastPrice,
    score,
    category:fallingKnife ? 'Falling Knife' : bowCategory(score),
    verdict:fallingKnife ? 'Avoid' : bowCategory(score),
    action:score >= 70 && !rejectReasons.length ? 'BOW_BUY' : 'AVOID',
    pullbackPct,
    rsiDaily,
    rsiWeekly,
    trend:trendOk ? 'Uptrend' : 'Rejected',
    volume:distributionDays >= 3 ? 'Distribution' : volumeConstructive ? 'Constructive' : 'Neutral',
    valuation:valuationSignals.length ? valuationSignals.join(', ') : 'Insufficient data',
    signals:reversals,
    relativeStrength,
    entry:entryModel,
    morningBoom: boom.score > 0 ? {
      score: boom.score,
      category: boom.category,
      factors: boom.factors,
      rangePosition: boom.rangePosition,
    } : null,
    preMarketPlan: !rejectReasons.length && boom.score >= 50 ? {
      strategy: boom.score >= 65 ? 'buy at open' : 'buy on intraday dip',
      entryOpen: Math.round(lastPrice * 1.01),
      entryLimit: entryModel?.aggressiveEntry ?? null,
      stopLoss: entryModel?.stopLoss ?? null,
      target: entryModel?.target1 ?? null,
      riskReward: entryModel?.riskReward ?? null,
      conviction: boom.category.toLowerCase(),
    } : null,
    components:{ trendScore, fundamentalScore, pullbackScore, volumeScore, rsScore, valuationScore, momentumScore },
    reasons:reasons.length ? reasons : ['Belum memenuhi edge Buy on Weakness'],
    risks,
    rejectReasons,
    warnings:risks.concat(rejectReasons),
    source:stock.source || 'yahoo-finance',
    timestamp:stock.timestamp || new Date().toISOString(),
  };
}

module.exports = { generateBowSignal };
