'use strict';

const { dataQualityScore } = require('./dataQuality');
const { calculateIndicators, clamp } = require('./indicators');
const { riskProfile } = require('./riskEngine');
const { inMorningBuyWindow, inAfternoonBuyWindow } = require('../market/idxSession');

function reasonList(ind) {
  const out = [];
  if (ind.changePct > 0) out.push('Momentum harga positif');
  if (ind.projectedVolRatio >= 1.3) out.push(`Volume proyeksi ${ind.projectedVolRatio.toFixed(1)}x rata-rata`);
  if (ind.rangePosition >= 0.7) out.push(`Harga bertahan di ${(ind.rangePosition * 100).toFixed(0)}% range harian`);
  if (ind.vwapDistancePct != null && ind.vwapDistancePct >= 0) out.push('Harga di atas VWAP');
  if (ind.dailyTrendScore >= 60) out.push('Trend harian mendukung');
  if (ind.intradayTrendScore >= 65) out.push('Momentum intraday kuat');
  if (ind.breakoutScore >= 60) out.push('Breakout high periode pendek terdeteksi');
  if (!out.length) out.push('Belum ada edge momentum yang kuat');
  return out;
}

function buyGates(indicators, risk, marketContext) {
  return risk.level !== 'HIGH'
    && indicators.changePct >= 0.5
    && indicators.changePct <= 8
    && indicators.projectedVolRatio >= 1.2
    && indicators.rangePosition >= 0.58
    && indicators.liquidityScore >= 45
    && indicators.lateFadeScore <= 45
    && indicators.volatilityControlScore >= 45
    && indicators.freshnessScore >= 55
    && (indicators.vwapDistancePct == null || indicators.vwapDistancePct >= -0.8)
    && (marketContext.ihsgChangePct ?? 0) > -1.0;
}

function strongBuyGates(indicators, risk, marketContext) {
  return buyGates(indicators, risk, marketContext)
    && indicators.changePct >= 1
    && indicators.changePct <= 6
    && indicators.projectedVolRatio >= 1.5
    && indicators.rangePosition >= 0.70
    && indicators.liquidityScore >= 60
    && indicators.intradayTrendScore >= 65
    && indicators.dailyTrendScore >= 50
    && indicators.freshnessScore >= 82
    && indicators.gapControlScore >= 70
    && indicators.volatilityControlScore >= 65
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
  let score = changeScore * 0.16
    + volumeScore * 0.16
    + projectedVolumeScore * 0.13
    + indicators.intradayTrendScore * 0.12
    + indicators.dailyTrendScore * 0.08
    + indicators.vwapScore * 0.08
    + rangePositionScore * 0.08
    + indicators.breakoutScore * 0.07
    + indicators.liquidityScore * 0.05
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
  else if (indicators.changePct > 0 && indicators.projectedVolRatio >= 1.2 && indicators.rangePosition >= 0.68 && indicators.intradayTrendScore >= 58 && risk.level !== 'HIGH') category = 'ACCUMULATION_PROXY';
  else if (indicators.projectedVolRatio >= 1.2 && indicators.rangePosition < 0.45 && indicators.lateFadeScore >= 45 && indicators.changePct <= 1) category = 'DISTRIBUTION_PROXY';

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
    reasons:reasonList(indicators),
    warnings:[...dq.warnings, ...risk.warnings],
    indicators,
    source:stock.source || 'yahoo-finance',
    timestamp:stock.timestamp || new Date().toISOString(),
  };
}

module.exports = { generateSignal };
