'use strict';

const { dataQualityScore } = require('./dataQuality');
const { calculateIndicators, clamp } = require('./indicators');
const { riskProfile } = require('./riskEngine');
const { inMorningBuyWindow, inAfternoonBuyWindow } = require('../market/idxSession');

function reasonList(ind, sessionStatus) {
  const out = [];
  if (ind.changePct > 0) out.push('Momentum harga positif');
  if (ind.projectedVolRatio >= 1.3) out.push(`Volume proyeksi ${ind.projectedVolRatio.toFixed(1)}x rata-rata`);
  if (ind.rangePosition >= 0.7) out.push(`Harga bertahan di ${(ind.rangePosition * 100).toFixed(0)}% range harian`);
  if (ind.vwapDistancePct != null && ind.vwapDistancePct >= 0) out.push('Harga di atas VWAP');
  if (ind.dailyTrendScore >= 60) out.push('Trend harian mendukung');
  if (ind.intradayTrendScore >= 65) out.push('Momentum intraday kuat');
  if (ind.breakoutScore >= 60) out.push('Breakout high periode pendek terdeteksi');
  if (ind.araPotentialScore >= 55) out.push(`Potensi ARA terdeteksi (${ind.araProgressPct.toFixed(0)}% dari batas, sisa ruang ${ind.distanceToAraPct != null ? ind.distanceToAraPct.toFixed(1) : '?'}%)`);
  if (ind.earlyMomentumScore >= 60) out.push('Momentum awal terdeteksi — akselerasi harga dini');
  if (ind.morningSetupScore >= 60 && sessionStatus === 'CLOSED') out.push('Setup pagi kuat — siap buy di sesi berikutnya');
  if (!out.length) out.push('Belum ada edge momentum yang kuat');
  return out;
}

function buyGates(indicators, risk, marketContext) {
  return risk.level !== 'HIGH'
    && indicators.changePct >= 0.5
    && indicators.changePct <= 25
    // FIX: was 1.2 — too restrictive for early runners that haven't yet printed a full
    // session's worth of elevated volume. A stock at 4-6% up with VWAP confirmation and
    // accelerating intraday candles should qualify for BUY well before volume is 20% above avg.
    && indicators.projectedVolRatio >= 1.0
    // FIX: was 0.58 — similar issue. Early runners can have rangePosition ~0.50 and still be
    // perfectly valid entries if they're accelerating above VWAP with buy flow.
    && indicators.rangePosition >= 0.50
    && indicators.liquidityScore >= 45
    && indicators.lateFadeScore <= 50
    && indicators.volatilityControlScore >= 40
    && indicators.freshnessScore >= 55
    && (indicators.vwapDistancePct == null || indicators.vwapDistancePct >= -0.8)
    && (marketContext.ihsgChangePct ?? 0) > -1.0;
}

function strongBuyGates(indicators, risk, marketContext) {
  return buyGates(indicators, risk, marketContext)
    && indicators.changePct >= 1
    && indicators.changePct <= 20
    && indicators.projectedVolRatio >= 1.3
    && indicators.rangePosition >= 0.60
    && indicators.liquidityScore >= 60
    && indicators.intradayTrendScore >= 60
    && indicators.dailyTrendScore >= 50
    && indicators.freshnessScore >= 82
    && indicators.gapControlScore >= 70
    && indicators.volatilityControlScore >= 60
    && (indicators.vwapDistancePct == null || indicators.vwapDistancePct >= 0)
    && (marketContext.ihsgChangePct ?? 0) > -0.5;
}

function generateSignal(stock, marketContext = {}, sessionContext = {}, histories = {}) {
  const now = histories.now || new Date();
  const dq = dataQualityScore(stock, now);
  const indicators = calculateIndicators(stock, histories.daily || [], histories.intraday || [], { ...sessionContext, now });
  const risk = riskProfile(stock, indicators, marketContext);
  const marketScore = marketContext.ihsgChangePct == null ? 50 : clamp(50 + marketContext.ihsgChangePct * 10);
  const changeScore = clamp(50 + indicators.changePct * 8);
  const volumeScore = clamp(indicators.volumeRatio * 45);
  const projectedVolumeScore = clamp(indicators.projectedVolRatio * 40);
  const rangePositionScore = clamp(indicators.rangePosition * 100);
  let score = changeScore * 0.14
    + volumeScore * 0.14
    + projectedVolumeScore * 0.12
    + indicators.intradayTrendScore * 0.10
    + indicators.dailyTrendScore * 0.07
    + indicators.vwapScore * 0.07
    + rangePositionScore * 0.07
    + indicators.breakoutScore * 0.06
    + indicators.araPotentialScore * 0.05
    + indicators.earlyMomentumScore * 0.05
    + indicators.liquidityScore * 0.04
    + indicators.freshnessScore * 0.03
    + indicators.gapControlScore * 0.02
    + indicators.volatilityControlScore * 0.02
    + marketScore * 0.03
    - risk.penalty;
  score = Math.round(clamp(score));
  const confidence = Math.round(clamp(dq.score * 0.45 + score * 0.35 + (risk.level === 'LOW' ? 20 : risk.level === 'MEDIUM' ? 10 : 0)));
  const canBuy = buyGates(indicators, risk, marketContext);
  const canStrongBuy = strongBuyGates(indicators, risk, marketContext);
  let action = 'HOLD';
  if (dq.score < 40) action = 'NO_DATA';
  else if (score >= 85 && dq.score >= 80 && confidence >= 75 && canStrongBuy) action = 'STRONG_BUY';
  else if (score >= 70 && dq.score >= 70 && canBuy) action = 'BUY';
  else if (score >= 60 && dq.score >= 60) action = 'WATCH';
  else if (score < 45 || risk.level === 'HIGH') action = indicators.changePct < -1 ? 'SELL' : 'AVOID';

  let category = action === 'STRONG_BUY' ? 'STRONG_BUY' : action === 'BUY' ? 'TOP_BUY' : action === 'SELL' || action === 'AVOID' ? 'RISK' : action === 'NO_DATA' ? 'NO_DATA' : 'TOP_GAINER';
  const morningDirect = inMorningBuyWindow(now) && score >= 75 && dq.score >= 75 && canBuy && indicators.changePct >= 0.8 && indicators.changePct <= 5 && indicators.projectedVolRatio >= 1.8 && indicators.rangePosition >= 0.75 && indicators.liquidityScore >= 60 && indicators.lateFadeScore <= 35;
  const afternoonDirect = inAfternoonBuyWindow(now) && score >= 75 && dq.score >= 75 && canBuy && indicators.rangePosition >= 0.70 && indicators.projectedVolRatio >= 1.3 && indicators.intradayTrendScore >= 70 && indicators.lateFadeScore <= 35;
  if (morningDirect) category = 'BELI_PAGI';
  else if (afternoonDirect) category = 'BELI_SORE';
  // Surface early ARA (auto-reject-up) candidates: stocks in the 3-10% range (25-40% of ARA
  // ceiling) with acceleration/volume confirmation but still plenty of room to run. Detected
  // BEFORE ACCUMULATION_PROXY so these get their own distinct label instead of being lumped
  // into the generic "accumulation proxy" which fires later (12%+ move).
  const araCandidate = indicators.araPotentialScore >= 55 && risk.level !== 'HIGH'
    && (indicators.distanceToAraPct == null || indicators.distanceToAraPct > 1);
  if (araCandidate && category !== 'STRONG_BUY' && category !== 'BELI_PAGI' && category !== 'BELI_SORE') category = 'ARA_CANDIDATE';
  // Full-confirmation accumulation (stock is already well into its move — the classic
  // "buy on strength" signal this revision tries to reduce reliance on).
  if (category === 'TOP_GAINER' && indicators.changePct > 0 && indicators.projectedVolRatio >= 1.2 && indicators.rangePosition >= 0.68 && indicators.intradayTrendScore >= 58 && risk.level !== 'HIGH') category = 'ACCUMULATION_PROXY';
  else if (indicators.projectedVolRatio >= 1.2 && indicators.rangePosition < 0.45 && indicators.lateFadeScore >= 45 && indicators.changePct <= 1) category = 'DISTRIBUTION_PROXY';
  // Early momentum: catch stocks just starting to accelerate (2-8% up) that didn't meet
  // full ARA/accumulation criteria yet. These are the earliest visible entry signals.
  if (category === 'TOP_GAINER' && indicators.earlyMomentumScore >= 60 && risk.level !== 'HIGH') category = 'EARLY_MOMENTUM';
  // Morning watch: evaluated when market is CLOSED or PRE_OPEN using prior-day data.
  // Stocks with a strong close, volume, daily trend, and near breakout levels — likely
  // to gap up or run early next session. Also surfaces during live trading as a filter.
  const isClosedOrPreOpen = sessionContext.status === 'CLOSED' || sessionContext.status === 'PRE_OPEN';
  if (isClosedOrPreOpen && indicators.morningSetupScore >= 60 && indicators.changePct > 0 && risk.level !== 'HIGH') {
    if (category === 'TOP_GAINER' || category === 'HOLD' || category === 'WATCH') category = 'MORNING_WATCH';
  }

  return {
    symbol:stock.symbol,
    yahooSymbol:stock.yahooSymbol,
    name:stock.name || stock.symbol,
    lastPrice:stock.lastPrice,
    previousClose:stock.previousClose,
    changePct:indicators.changePct,
    volume:stock.volume,
    avgVolume20:stock.avgVolume20,
    tradedValue:indicators.tradedValue,
    score,
    action,
    category,
    sessionTag:sessionContext.status,
    riskLevel:risk.level,
    dataQuality:dq.score,
    confidence,
    reasons:reasonList(indicators, sessionContext.status),
    warnings:[...dq.warnings, ...risk.warnings],
    indicators,
    source:stock.source || 'yahoo-finance',
    timestamp:stock.timestamp || new Date().toISOString(),
  };
}

module.exports = { generateSignal };
