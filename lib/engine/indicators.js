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
  // MOMENTUM ACCELERATION — detects if a stock is accelerating intraday
  // (e.g. quiet for 2 hours then suddenly starts running). Strong leading
  // indicator for ARA candidates before volume/range fully confirm.
  const acceleration = (function () {
    if (closes.length < 6) return 50;
    const mid = Math.floor(closes.length / 2);
    const earlyChg = closes[0] > 0 ? ((closes[mid - 1] - closes[0]) / closes[0]) * 100 : 0;
    const lateChg = closes[mid] > 0 ? ((closes[closes.length - 1] - closes[mid]) / closes[mid]) * 100 : 0;
    return clamp(50 + (lateChg - earlyChg) * 12);
  })();

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
  // FIX: sweet spot was at 58% progress (= 14-20% gain), detecting stocks only after they had
  // already run most of their move. Now peaks at 25% progress (= 6-9% gain), the early
  // acceleration zone where the real entry opportunity lives.
  const araSweetSpot = clamp(100 - Math.abs(araProgressPct - 25) * 1.6);
  const araVolumeConfirm = clamp(Math.max(0, projectedVolRatio - 0.6) * 20, 0, 30);
  const araRangeConfirm = rangePosition >= 0.55 ? 15 : rangePosition >= 0.35 ? 5 : 0;
  const araAccelBonus = clamp((acceleration - 45) * 0.4, 0, 15);
  const araRoomFactor = clamp(1 - Math.max(0, (araProgressPct - 80) / 20), 0, 1);
  const araPotentialScore = araProgressPct <= 0 ? 0 : clamp((araSweetSpot * 0.35 + araVolumeConfirm + araRangeConfirm + araAccelBonus) * araRoomFactor);

  // ---------------------------------------------------------------------
  // EARLY MOMENTUM — catches runners at 2-10% up before they meet the
  // formal buyGates. Conservative enough to avoid noise, sensitive enough
  // to surface the first hour of a potential ARA day.
  const earlyMomentumScore = clamp(
    (changePct > 0 && changePct <= 12 ? (changePct / 12) * 45 : 0) +
    (projectedVolRatio > 0.8 ? clamp((projectedVolRatio - 0.8) * 25, 0, 20) : 0) +
    (vwapDistancePct != null && vwapDistancePct > 0 ? 15 : vwapDistancePct != null && vwapDistancePct > -0.5 ? 5 : 0) +
    (rangePosition >= 0.45 ? (rangePosition - 0.45) * 20 : 0) +
    (acceleration - 50) * 0.3 +
    (lateFadeScore <= 40 ? 8 : 0), 0, 100
  );

  // ---------------------------------------------------------------------
  // MORNING SETUP — evaluates a stock's readiness for a morning run based on
  // prior-day data. Works when market is CLOSED (evening/pre-open analysis)
  // AND during live trading as a confidence booster. High score = strong setup
  // carried forward from the previous session.
  //   - Strong close (held near high = low late fade)
  //   - Volume pickup
  //   - Daily trend supporting
  //   - Near breakout level
  //   - Liquid enough
  const morningSetupScore = clamp(
    (rangePosition >= 0.65 ? 25 : rangePosition >= 0.50 ? 15 : rangePosition >= 0.35 ? 8 : 0) +
    (volumeRatio >= 1.5 ? 20 : volumeRatio >= 1.2 ? 12 : volumeRatio >= 0.9 ? 5 : 0) +
    (dailyTrendScore >= 60 ? 18 : dailyTrendScore >= 50 ? 10 : 0) +
    (breakoutScore >= 50 ? 15 : breakoutScore >= 35 ? 8 : 0) +
    (lateFadeScore <= 30 ? 12 : lateFadeScore <= 50 ? 6 : 0) +
    (liquidityScore >= 45 ? 10 : 0), 0, 100
  );
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
    acceleration,
    earlyMomentumScore,
    morningSetupScore,
    sessionProgressAdjustedVolume:projectedVolRatio,
  };
}

module.exports = { calculateIndicators, clamp };
