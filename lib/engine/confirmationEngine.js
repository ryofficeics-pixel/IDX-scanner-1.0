'use strict';

const { clamp } = require('./indicators');

function confirmationFeatures(indicators) {
  const projectedVolumeScore = clamp(indicators.projectedVolRatio * 42);
  const rangeScore = clamp(indicators.rangePosition * 100);
  const confirmationScore = Math.round(clamp(
    projectedVolumeScore * 0.24
    + indicators.intradayTrendScore * 0.20
    + indicators.dailyTrendScore * 0.16
    + indicators.vwapScore * 0.12
    + rangeScore * 0.12
    + indicators.breakoutScore * 0.10
    + indicators.freshnessScore * 0.06
  ));
  return { confirmationScore };
}

module.exports = { confirmationFeatures };
