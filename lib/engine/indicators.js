'use strict';

function clamp(v, lo = 0, hi = 100) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function div(a, b, fb = 0) {
  a = Number(a); b = Number(b);
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : fb;
}

function calculateIndicators(stock, daily = [], intraday = [], session = {}) {
  const lastPrice = Number(stock.lastPrice);
  const previousClose = Number(stock.previousClose);
  const dayHigh = Number(stock.dayHigh);
  const dayLow = Number(stock.dayLow);
  const volume = Number(stock.volume);
  const avgVolume20 = Number(stock.avgVolume20);
  const changePct = previousClose > 0 && lastPrice > 0 ? ((lastPrice - previousClose) / previousClose) * 100 : Number(stock.changePct) || 0;
  const rangePosition = dayHigh > dayLow ? clamp((lastPrice - dayLow) / (dayHigh - dayLow), 0, 1) : 0.5;
  const volumeRatio = avgVolume20 > 0 ? div(volume, avgVolume20, 0) : 0;
  const expected = Math.max(0.08, Number(session.expectedVolumeProgress) || 0.35);
  const projectedVolRatio = volumeRatio ? div(volumeRatio, expected, volumeRatio) : 0;
  const tradedValue = Number.isFinite(volume) && Number.isFinite(lastPrice) ? volume * lastPrice : 0;
  const liquidityScore = clamp(Math.log10(Math.max(tradedValue, 1)) * 11 - 45);
  const closes = intraday.map((c) => Number(c.close)).filter(Number.isFinite);
  const intradayMA = closes.length ? closes.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, closes.length) : null;
  const vwapDen = intraday.reduce((a, c) => a + (Number(c.volume) || 0), 0);
  const vwap = vwapDen > 0 ? intraday.reduce((a, c) => a + ((Number(c.close) || 0) * (Number(c.volume) || 0)), 0) / vwapDen : null;
  const intradayTrendScore = closes.length >= 2 ? clamp(50 + div(closes[closes.length - 1] - closes[0], closes[0], 0) * 900 + (vwap && lastPrice > vwap ? 12 : 0)) : clamp(50 + changePct * 8);
  const dailyHigh5 = Math.max(...daily.slice(-5).map((c) => Number(c.high)).filter(Number.isFinite), 0);
  const dailyHigh20 = Math.max(...daily.slice(-20).map((c) => Number(c.high)).filter(Number.isFinite), 0);
  const breakout5D = dailyHigh5 > 0 && lastPrice >= dailyHigh5 * 0.995;
  const breakout20D = dailyHigh20 > 0 && lastPrice >= dailyHigh20 * 0.995;
  const breakoutScore = clamp((breakout5D ? 45 : 0) + (breakout20D ? 35 : 0) + Math.max(0, changePct) * 5);
  const distanceFromHigh = dayHigh > 0 ? div(dayHigh - lastPrice, dayHigh, 0) * 100 : 0;
  const lateFadeScore = clamp(distanceFromHigh * 18 + (rangePosition < 0.45 ? 25 : 0));
  const volatilityRisk = clamp(Math.abs(changePct) * 9 + (dayHigh > dayLow ? div(dayHigh - dayLow, lastPrice, 0) * 500 : 0));
  return {
    changePct,
    rangePosition,
    volumeRatio,
    projectedVolRatio,
    tradedValue,
    liquidityScore,
    intradayMA,
    VWAP:vwap,
    intradayTrendScore,
    breakout5D,
    breakout20D,
    breakoutScore,
    distanceFromHigh,
    lateFadeScore,
    volatilityRisk,
    sessionProgressAdjustedVolume:projectedVolRatio,
  };
}

module.exports = { calculateIndicators, clamp };
