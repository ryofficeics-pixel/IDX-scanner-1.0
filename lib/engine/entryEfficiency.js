'use strict';

const { clamp } = require('./indicators');

function entryEfficiency(indicators, setup, stock = {}) {
  const atrUnits = indicators.atrPct > 0 ? Math.max(0, indicators.changePct) / indicators.atrPct : 0;
  const movingAverageExtensionPct = indicators.sma5 > 0
    ? (Number(stock.lastPrice) / indicators.sma5 - 1) * 100
    : Math.max(0, indicators.changePct);
  const supportDistancePct = Math.max(0, indicators.vwapDistancePct ?? 0, movingAverageExtensionPct || 0);
  const openExtensionPct = stock.dayOpen > 0 ? (stock.lastPrice / stock.dayOpen - 1) * 100 : null;
  const chasePenalty = Math.round(clamp(
    Math.max(0, indicators.changePct - 4) * 4
    + Math.max(0, (indicators.vwapDistancePct ?? 0) - 2) * 8
    + Math.max(0, atrUnits - 1.5) * 10
    + Math.max(0, indicators.araProgressPct - 65) * 0.8
    + Math.max(0, supportDistancePct - 5) * 3
    + Math.max(0, (openExtensionPct ?? 0) - 6) * 2
  ));
  const extensionScore = chasePenalty;
  const entryEfficiencyScore = Math.round(clamp(100 - chasePenalty + (setup.breakoutProximityScore - 50) * 0.15));
  return { chasePenalty, extensionScore, entryEfficiencyScore, supportDistancePct, movingAverageExtensionPct, openExtensionPct, extended:chasePenalty >= 45 };
}

module.exports = { entryEfficiency };
