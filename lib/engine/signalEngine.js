'use strict';

const { dataQualityScore } = require('./dataQuality');
const { calculateIndicators, clamp } = require('./indicators');
const { riskProfile } = require('./riskEngine');
const { setupFeatures } = require('./setupEngine');
const { partitionIntraday, triggerFeatures } = require('./triggerEngine');
const { confirmationFeatures } = require('./confirmationEngine');
const { entryEfficiency } = require('./entryEfficiency');
const { marketRegime } = require('./regimeEngine');
const { inMorningBuyWindow, inAfternoonBuyWindow } = require('../market/idxSession');
const config = require('../config/signalConfig');
const { completedDaily, number, verifiedQuote } = require('../market/historyContext');

function reasonList(ind, sessionStatus) {
  const out = [];
  if (ind.setupScore >= config.thresholds.setup) out.push('Setup pra-breakout terdeteksi');
  if (ind.volatilityCompressionScore >= 60) out.push('Volatilitas dan rentang harga sedang menyempit');
  if (ind.breakoutProximityScore >= 70) out.push('Harga mendekati resistance tanpa perlu menunggu breakout penuh');
  if (ind.volumeAccelerationScore >= 60) out.push('Volume mulai berakselerasi');
  if (ind.vwapReclaim) out.push('Harga merebut kembali VWAP');
  else if (ind.vwapBounce) out.push('Harga memantul dari VWAP');
  if (ind.openingRangeBreakout) out.push('Breakout opening range dengan struktur pagi yang valid');
  if (ind.microBreakout) out.push('Resistance intraday pendek ditembus');
  if (ind.confirmationScore >= 65) out.push('Konfirmasi tren dan volume mendukung');
  if (ind.entryEfficiencyScore < 55) out.push('Momentum kuat, tetapi efisiensi entry menurun');
  const isNightOrPreOpen = sessionStatus === 'CLOSED' || sessionStatus === 'PRE_OPEN';
  if (ind.morningSetupScore >= 60 && isNightOrPreOpen) out.push('Setup untuk sesi berikutnya terdeteksi');
  if (!out.length) out.push('Belum ada edge setup atau pemicu yang kuat');
  return out;
}

function earlyDemand(indicators) {
  const limits = config.earlyDemand;
  return (indicators.atrPct >= limits.minimumAtrPct || (indicators.volumeAcceleration >= limits.exceptionalVolumeAcceleration && indicators.priceAcceleration >= limits.exceptionalPriceAcceleration))
    && (indicators.volatilityCompressionScore >= limits.compressionScore || indicators.confirmationScore >= limits.confirmationScore)
    && (indicators.projectedVolRatio >= limits.relativeVolume || indicators.volumeAcceleration >= limits.localVolumeAcceleration) && indicators.rangePosition >= limits.rangePosition
    && indicators.changePct >= limits.minimumChangePct && indicators.priceVelocity >= limits.priceVelocity
    && (indicators.volumeAcceleration >= limits.volumeAcceleration || indicators.relativeVolumeAcceleration >= limits.relativeVolumeAcceleration);
}

function buyGates(indicators, risk, marketContext) {
  const earlyTrigger = indicators.setupScore >= config.thresholds.setup
    && indicators.triggerScore >= config.thresholds.trigger
    && (indicators.priceAcceleration > 0 || indicators.volumeAccelerationScore >= 55 || indicators.vwapReclaim || indicators.microBreakout);
  return risk.level !== 'HIGH'
    && indicators.setupHistoryAvailable && indicators.triggerHistoryAvailable
    && earlyDemand(indicators)
    && earlyTrigger
    && indicators.entryEfficiencyScore >= 50
    && indicators.liquidityScore >= 40
    && indicators.freshnessScore >= 55
    && indicators.falseBreakoutPenalty < 35
    && indicators.rangePosition >= 0.5 && indicators.lateFadeScore <= 50
    && (indicators.distanceToAraPct == null || indicators.distanceToAraPct > 1);
}

function strongBuyGates(indicators, risk, marketContext) {
  return buyGates(indicators, risk, marketContext)
    && indicators.confirmationScore >= 72
    && indicators.triggerScore >= 66
    && indicators.changePct >= 1 && indicators.changePct <= 20
    && indicators.projectedVolRatio >= 1.3
    && indicators.rangePosition >= 0.60
    && indicators.liquidityScore >= 60
    && indicators.intradayTrendScore >= 60 && indicators.dailyTrendScore >= 50
    && indicators.gapControlScore >= 70 && indicators.volatilityControlScore >= 60
    && indicators.freshnessScore >= 82
    && indicators.entryEfficiencyScore >= 58
    && (indicators.vwapDistancePct == null || indicators.vwapDistancePct >= 0)
    && (marketContext.ihsgChangePct ?? 0) > -0.5;
}

function swingExitModel(lastPrice) {
  if (!(number(lastPrice) > 0)) return null;
  const target = Math.round(lastPrice * 1.03);
  const stop = Math.round(lastPrice * 0.98);
  return { entry:Math.round(lastPrice), target, stop, riskReward:((target - lastPrice) / (lastPrice - stop)).toFixed(2), holdDays:5 };
}

function signalPhase(indicators) {
  if (indicators.failedBreakout) return 'FAILED';
  if (indicators.extended) return 'EXTENDED';
  if (!indicators.setupHistoryAvailable) return 'DORMANT';
  if (indicators.triggerScore >= 66 && indicators.confirmationScore >= 72 && indicators.setupScore >= config.thresholds.setup) return 'CONFIRMED';
  if (indicators.setupScore >= config.thresholds.setup && indicators.triggerScore >= config.thresholds.trigger) return 'TRIGGERED';
  if (indicators.setupScore >= config.thresholds.armed) return 'ARMED';
  if (indicators.setupScore >= config.thresholds.setup) return 'SETUP';
  return 'DORMANT';
}

function generateSignal(stock, marketContext = {}, sessionContext = {}, histories = {}) {
  const now = histories.now || new Date();
  const daily = completedDaily(histories.daily || [], now);
  const ihsgDaily = completedDaily(histories.ihsgDaily || [], now);
  const partitioned = partitionIntraday(histories.intraday || [], now);
  stock = verifiedQuote(stock, partitioned.current);
  const base = calculateIndicators(stock, daily, partitioned.current, { ...sessionContext, now });
  const setup = setupFeatures(stock, daily, ihsgDaily);
  const trigger = triggerFeatures(stock, partitioned.current, { ...sessionContext, now }, histories.intradayBaselines || partitioned.baselines);
  const volumeAdjusted = trigger.timeOfDayVolumeRatio == null ? base : {
    ...base,
    projectedVolRatio:trigger.timeOfDayVolumeRatio,
    sessionProgressAdjustedVolume:trigger.timeOfDayVolumeRatio,
  };
  const staged = { ...volumeAdjusted, ...setup, ...trigger };
  staged.dailySetupScore = setup.setupScore;
  staged.setupScore = Math.round(Math.max(setup.setupScore, trigger.intradaySetupScore * 0.70 + setup.setupScore * 0.30));
  const confirmation = confirmationFeatures(staged);
  const entry = entryEfficiency(staged, setup, stock);
  const indicators = { ...staged, ...confirmation, ...entry };
  const regime = marketRegime(marketContext, ihsgDaily);
  return classifySignal(stock, marketContext, sessionContext, indicators, regime, now);
}

function classifySignal(stock, marketContext, sessionContext, indicators, regime, now) {
  const dq = dataQualityScore(stock, now);
  const risk = riskProfile(stock, indicators, marketContext);
  const weights = config.scoreWeights;
  const score = Math.round(clamp(
    indicators.setupScore * weights.setup
    + indicators.triggerScore * weights.trigger
    + indicators.confirmationScore * weights.confirmation
    + indicators.entryEfficiencyScore * weights.entry
    + regime.scoreAdjustment
    - risk.penalty
  ));
  const confidence = Math.round(clamp(dq.score * 0.42 + score * 0.38 + indicators.confirmationScore * 0.20 - risk.penalty * 0.4));
  const phase = signalPhase(indicators);
  const canBuy = buyGates(indicators, risk, marketContext);
  const canStrongBuy = strongBuyGates(indicators, risk, marketContext);

  let action = 'HOLD';
  if (dq.score < 40) action = 'NO_DATA';
  else if (risk.level === 'HIGH') action = indicators.changePct < -1 ? 'SELL' : 'AVOID';
  else if (canStrongBuy && score >= config.thresholds.strongBuy && dq.score >= 80 && confidence >= 75) action = 'STRONG_BUY';
  else if (canBuy && score >= config.thresholds.buy && dq.score >= 70) action = 'BUY';
  else if (['SETUP', 'ARMED', 'TRIGGERED', 'CONFIRMED'].includes(phase) && dq.score >= 60) action = 'WATCH';
  else if (score < 42 && indicators.changePct < -1 && indicators.lateFadeScore > 50) action = 'SELL';

  let category = action === 'STRONG_BUY' ? 'STRONG_BUY'
    : action === 'BUY' ? 'TOP_BUY'
    : action === 'SELL' || action === 'AVOID' ? 'RISK'
    : action === 'NO_DATA' ? 'NO_DATA'
    : 'TOP_GAINER';
  const morningDirect = inMorningBuyWindow(now) && canBuy && indicators.openingRangeBreakout && indicators.entryEfficiencyScore >= 60;
  const afternoonDirect = inAfternoonBuyWindow(now) && canBuy && indicators.confirmationScore >= 70 && indicators.lateFadeScore <= 35;
  if (action === 'BUY' && morningDirect) category = 'BELI_PAGI';
  else if (action === 'BUY' && afternoonDirect) category = 'BELI_SORE';

  const araSetupScore = Math.round(clamp(indicators.setupScore * 0.48 + indicators.triggerScore * 0.37 + indicators.relativeStrengthScore * 0.15));
  const araContinuationScore = Math.round(clamp(indicators.confirmationScore * 0.55 + indicators.intradayTrendScore * 0.25 + indicators.rangePosition * 20));
  let araPhase = null;
  if (indicators.setupHistoryAvailable && indicators.triggerHistoryAvailable && indicators.changePct >= 2 && indicators.araPotentialScore >= 55
    && (indicators.distanceToAraPct == null || indicators.distanceToAraPct > 1)) araPhase = 'CONTINUATION';
  else if (araSetupScore >= 68 && phase === 'TRIGGERED' && earlyDemand(indicators)) araPhase = 'TRIGGER';
  else if (araSetupScore >= 65 && ['SETUP', 'ARMED'].includes(phase)) araPhase = 'SETUP';
  if (araPhase && (araPhase !== 'SETUP' || earlyDemand(indicators)) && !['STRONG_BUY', 'BELI_PAGI', 'BELI_SORE', 'NO_DATA'].includes(category) && risk.level !== 'HIGH') category = 'ARA_CANDIDATE';

  if (indicators.projectedVolRatio >= 1.2 && indicators.rangePosition < 0.45 && indicators.lateFadeScore >= 45 && indicators.changePct <= 1) category = 'DISTRIBUTION_PROXY';
  else if (category === 'TOP_GAINER' && indicators.confirmationScore >= 68 && indicators.changePct > 0 && risk.level !== 'HIGH') category = 'ACCUMULATION_PROXY';
  if (category === 'TOP_GAINER' && ['ARMED', 'TRIGGERED', 'CONFIRMED'].includes(phase) && indicators.triggerScore >= config.thresholds.trigger
    && earlyDemand(indicators) && indicators.priceAcceleration > 0 && risk.level !== 'HIGH') category = 'EARLY_MOMENTUM';

  const isClosedOrPreOpen = sessionContext.status === 'CLOSED' || sessionContext.status === 'PRE_OPEN';
  const morningSetupScore = Math.round(clamp(indicators.dailySetupScore * 0.70 + indicators.dailyTrendScore * 0.15 + indicators.flowScore * 0.15));
  indicators.morningSetupScore = morningSetupScore;
  if (isClosedOrPreOpen && morningSetupScore >= 60 && risk.level !== 'HIGH' && ['TOP_GAINER', 'EARLY_MOMENTUM'].includes(category)) category = 'MORNING_WATCH';

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
    signalPhase:phase,
    setupScore:indicators.setupScore,
    triggerScore:indicators.triggerScore,
    confirmationScore:indicators.confirmationScore,
    entryEfficiencyScore:indicators.entryEfficiencyScore,
    chasePenalty:indicators.chasePenalty,
    araPhase,
    araSetupScore,
    araContinuationScore,
    riskLevel:risk.level,
    riskScore:risk.riskScore,
    riskComponents:risk.riskComponents,
    marketRegime:regime.regime,
    dataQuality:dq.score,
    confidence,
    reasons:reasonList(indicators, sessionContext.status),
    warnings:[...dq.warnings, ...risk.warnings],
    indicators,
    source:stock.source || 'yahoo-finance',
    timestamp:stock.timestamp || new Date().toISOString(),
    swingExit:swingExitModel(stock.lastPrice),
  };
}

module.exports = { generateSignal, classifySignal, signalPhase };
