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
  const timestampMs = stock.timestamp ? new Date(stock.timestamp).getTime() : NaN;
  const referenceNow = session.now ? new Date(session.now).getTime() : Date.now();
  const dataAgeMinutes = Number.isFinite(timestampMs) && Number.isFinite(referenceNow) ? Math.max(0, (referenceNow - timestampMs) / 60000) : null;
  const rangePosition = dayHigh > dayLow ? clamp((lastPrice - dayLow) / (dayHigh - dayLow), 0, 1) : 0.5;
  const dayRangePct = dayHigh > dayLow && lastPrice > 0 ? div(dayHigh - dayLow, lastPrice, 0) * 100 : 0;
  const volumeRatio = avgVolume20 > 0 ? div(volume, avgVolume20, 0) : 0;
  const expected = Math.max(0.08, Number(session.expectedVolumeProgress) || 0.35);
  const projectedVolRatio = volumeRatio ? div(volumeRatio, expected, volumeRatio) : 0;
  const tradedValue = Number.isFinite(volume) && Number.isFinite(lastPrice) ? volume * lastPrice : 0;
  const liquidityScore = clamp(Math.log10(Math.max(tradedValue, 1)) * 11 - 45);
  const closes = intraday.map((c) => Number(c.close)).filter(Number.isFinite);
  const intradayMA = closes.length ? closes.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, closes.length) : null;
  const vwapDen = intraday.reduce((a, c) => a + (Number(c.volume) || 0), 0);
  const vwap = vwapDen > 0 ? intraday.reduce((a, c) => a + ((Number(c.close) || 0) * (Number(c.volume) || 0)), 0) / vwapDen : null;
  const vwapDistancePct = vwap && lastPrice > 0 ? div(lastPrice - vwap, vwap, 0) * 100 : null;
  const vwapScore = vwapDistancePct == null ? 50 : clamp(50 + vwapDistancePct * 8);
  const intradayTrendScore = closes.length >= 2 ? clamp(50 + div(closes[closes.length - 1] - closes[0], closes[0], 0) * 900 + (vwap && lastPrice > vwap ? 12 : 0)) : clamp(50 + changePct * 8);
  const dailyCloses = daily.map((c) => Number(c.close)).filter(Number.isFinite);
  const sma = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const sma5 = sma(dailyCloses.slice(-5));
  const sma20 = sma(dailyCloses.slice(-20));
  const dailyTrendScore = sma5 && sma20 && lastPrice > 0
    ? clamp(50 + div(sma5 - sma20, sma20, 0) * 600 + (lastPrice > sma5 ? 12 : -8) + (lastPrice > sma20 ? 8 : -10))
    : 50;
  const dailyHigh5 = Math.max(...daily.slice(-5).map((c) => Number(c.high)).filter(Number.isFinite), 0);
  const dailyHigh20 = Math.max(...daily.slice(-20).map((c) => Number(c.high)).filter(Number.isFinite), 0);
  const breakout5D = dailyHigh5 > 0 && lastPrice >= dailyHigh5 * 0.995;
  const breakout20D = dailyHigh20 > 0 && lastPrice >= dailyHigh20 * 0.995;
  const breakoutScore = clamp((breakout5D ? 45 : 0) + (breakout20D ? 35 : 0) + Math.max(0, changePct) * 5);
  const distanceFromHigh = dayHigh > 0 ? div(dayHigh - lastPrice, dayHigh, 0) * 100 : 0;
  const lateFadeScore = clamp(distanceFromHigh * 18 + (rangePosition < 0.45 ? 25 : 0));
  const volatilityRisk = clamp(Math.abs(changePct) * 9 + dayRangePct * 5);
  const freshnessScore = dataAgeMinutes == null ? 40 : dataAgeMinutes <= 5 ? 100 : dataAgeMinutes <= 15 ? 82 : dataAgeMinutes <= 30 ? 55 : 25;
  // FIX: was symmetric -- penalized a big upside move (a real breakout) exactly like a big
  // downside gap, silently re-capping STRONG_BUY eligibility around ~8% intraday even after
  // raising the changePct ceiling in signalEngine.js. Now only penalizes downside moves and
  // excessive whipsaw range.
  const gapControlScore = clamp(100 - Math.max(0, -changePct - 5) * 9 - (changePct < -1 ? 12 : 0) - Math.max(0, dayRangePct - 18) * 2.5);
  // FIX: same bug class as gapControlScore -- penalized dayRangePct and |changePct| symmetrically,
  // crushing a clean 15-18% trend day to near-zero. Real instability is *excess* range beyond
  // what the net move explains (whipsaw), not the size of a clean directional move.
  const excessRangePct = Math.max(0, dayRangePct - Math.abs(changePct));
  const volatilityControlScore = clamp(100 - excessRangePct * 6 - Math.max(0, Math.abs(changePct) - 22) * 5);

  // ---------------------------------------------------------------------
  // ARA (Auto Rejection Atas / upper daily limit) proximity & potential.
  // Bands per IDX Kep-00055/BEI/03-2023 (confirmed current as of 2025 sources):
  //   Rp50-Rp200: 35% | >Rp200-Rp5,000: 25% | >Rp5,000: 20%
  // NOTE: verify against the current IDX trading rule circular before relying on this for real
  // trades. IPO/newly-listed stocks get a wider band (historically ~2x) -- not modeled here.
  function araBandPct(refPrice) {
    if (!(refPrice > 0)) return 20;
    if (refPrice <= 200) return 35;
    if (refPrice <= 5000) return 25;
    return 20;
  }
  const araThresholdPct = araBandPct(previousClose > 0 ? previousClose : lastPrice);
  const araCeiling = previousClose > 0 ? previousClose * (1 + araThresholdPct / 100) : null;
  const distanceToAraPct = araCeiling && lastPrice > 0 ? ((araCeiling - lastPrice) / lastPrice) * 100 : null;
  const araProgressPct = araThresholdPct > 0 ? clamp((changePct / araThresholdPct) * 100, 0, 150) : 0;
  const araSweetSpot = clamp(100 - Math.abs(araProgressPct - 58) * 2.1);
  const araVolumeConfirm = clamp(Math.max(0, projectedVolRatio - 1) * 40, 0, 40);
  const araRangeConfirm = rangePosition >= 0.7 ? 20 : rangePosition >= 0.5 ? 8 : 0;
  const araRoomFactor = clamp(1 - Math.max(0, (araProgressPct - 70) / 30), 0, 1);
  const araPotentialScore = araProgressPct <= 0 ? 0 : clamp((araSweetSpot * 0.5 + araVolumeConfirm + araRangeConfirm) * araRoomFactor);
  return {
    changePct,
    dataAgeMinutes,
    rangePosition,
    dayRangePct,
    volumeRatio,
    projectedVolRatio,
    tradedValue,
    liquidityScore,
    intradayMA,
    VWAP:vwap,
    vwapDistancePct,
    vwapScore,
    intradayTrendScore,
    sma5,
    sma20,
    dailyTrendScore,
    breakout5D,
    breakout20D,
    breakoutScore,
    distanceFromHigh,
    lateFadeScore,
    volatilityRisk,
    freshnessScore,
    gapControlScore,
    volatilityControlScore,
    araThresholdPct,
    araCeiling,
    distanceToAraPct,
    araProgressPct,
    araPotentialScore,
    sessionProgressAdjustedVolume:projectedVolRatio,
  };
}

module.exports = { calculateIndicators, clamp };
