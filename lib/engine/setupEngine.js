'use strict';

const { clamp } = require('./indicators');
const { number, dayKey } = require('../market/historyContext');

function mean(values) {
  const clean = values.map((value) => number(value)).filter((value) => value != null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function returnPct(values, window) {
  if (values.length <= window || !(values[values.length - 1] > 0) || !(values[values.length - 1 - window] > 0)) return null;
  return ((values[values.length - 1] - values[values.length - 1 - window]) / values[values.length - 1 - window]) * 100;
}

function relativeStrength(closes, marketCloses) {
  const windows = [5, 20, 60];
  const excess = windows.map((window) => {
    const stockReturn = returnPct(closes, window);
    const marketReturn = returnPct(marketCloses, window);
    return stockReturn == null || marketReturn == null ? null : stockReturn - marketReturn;
  });
  const available = excess.filter((value) => value != null);
  const level = available.length ? mean(available) : 0;
  const acceleration = excess[0] != null && excess[1] != null ? excess[0] - excess[1] / 4 : 0;
  return { relativeStrength5d:excess[0], relativeStrength20d:excess[1], relativeStrength60d:excess[2], relativeStrengthAcceleration:acceleration, score:clamp(50 + level * 4 + acceleration * 5) };
}

function setupFeatures(stock, daily = [], marketDaily = []) {
  const rows = daily.filter((row) => number(row.close) > 0);
  const closes = rows.map((row) => number(row.close));
  const lastPrice = number(stock.lastPrice, closes[closes.length - 1]);
  const ranges = rows.map((row, index) => {
    const close = number(row.close);
    const high = number(row.high, close);
    const low = number(row.low, close);
    const prior = index ? number(rows[index - 1].close, close) : close;
    return close > 0 ? Math.max(high - low, Math.abs(high - prior), Math.abs(low - prior)) / prior * 100 : null;
  }).filter((value) => value != null);
  const shortRange = mean(ranges.slice(-5));
  const longRange = mean(ranges.slice(-20));
  const compressionRatio = shortRange != null && longRange > 0 ? shortRange / longRange : null;
  const volatilityCompressionScore = compressionRatio == null ? 45 : clamp(115 - compressionRatio * 75);

  const recent5 = rows.slice(-5);
  const high5 = recent5.length ? Math.max(...recent5.map((row) => number(row.high, number(row.close)))) : null;
  const low5 = recent5.length ? Math.min(...recent5.map((row) => number(row.low, number(row.close)))) : null;
  const high20 = rows.length ? Math.max(...rows.slice(-20).map((row) => number(row.high, number(row.close)))) : null;
  const tightnessPct = high5 > 0 && low5 > 0 ? ((high5 - low5) / ((high5 + low5) / 2)) * 100 : null;
  const priceTightnessScore = tightnessPct == null ? 45 : clamp(100 - tightnessPct * 13);

  const distanceTo5dHighPct = high5 > 0 && lastPrice > 0 ? ((high5 - lastPrice) / high5) * 100 : null;
  const distanceTo20dHighPct = high20 > 0 && lastPrice > 0 ? ((high20 - lastPrice) / high20) * 100 : null;
  const proximity = (distance) => distance == null ? 40 : distance < -2 ? 20 : distance <= 0 ? 82 : clamp(100 - Math.abs(distance - 1.5) * 18);
  const breakoutProximityScore = Math.max(proximity(distanceTo5dHighPct), proximity(distanceTo20dHighPct));

  const volumes = rows.map((row) => number(row.volume)).filter((value) => value > 0);
  const volume5 = mean(volumes.slice(-5));
  const volume20 = mean(volumes.slice(-20));
  const volumeDryUpRatio = volume5 != null && volume20 > 0 ? volume5 / volume20 : null;
  const stableClose = closes.length >= 5 && closes[closes.length - 5] > 0
    ? Math.abs((closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5] * 100) <= 3
    : false;
  const volumeDryUpScore = volumeDryUpRatio == null ? 40 : clamp((stableClose ? 85 : 65) - Math.abs(volumeDryUpRatio - 0.7) * 70);

  const lows = rows.slice(-5).map((row) => number(row.low, number(row.close)));
  let higherLowCount = 0;
  for (let i = 1; i < lows.length; i += 1) if (lows[i] >= lows[i - 1]) higherLowCount += 1;
  const higherLowsScore = lows.length >= 3 ? clamp(higherLowCount / (lows.length - 1) * 100) : 45;
  const marketByDay = new Map(marketDaily.filter((row) => row.date || row.timestamp).map((row) => [dayKey(row.date || row.timestamp), number(row.close)]));
  const aligned = rows.filter((row) => (row.date || row.timestamp) && marketByDay.has(dayKey(row.date || row.timestamp)));
  const rs = relativeStrength(aligned.map((row) => number(row.close)), aligned.map((row) => marketByDay.get(dayKey(row.date || row.timestamp))));

  const tradedValue = number(stock.volume, 0) * number(stock.lastPrice, 0);
  const liquidityScore = clamp(Math.log10(Math.max(tradedValue, 1)) * 12 - 52);
  const netBuy = number(stock.cumulative3dNetBuy, number(stock.netBuy));
  const flowScore = netBuy == null ? 50 : clamp(50 + (netBuy / Math.max(tradedValue, 1)) * 180);
  const setupScore = Math.round(clamp(
    volatilityCompressionScore * 0.22
    + priceTightnessScore * 0.18
    + breakoutProximityScore * 0.22
    + volumeDryUpScore * 0.12
    + higherLowsScore * 0.10
    + rs.score * 0.10
    + liquidityScore * 0.04
    + flowScore * 0.02
  ));

  return {
    setupScore,
    setupHistoryAvailable:rows.length >= 20,
    volatilityCompressionScore:Math.round(volatilityCompressionScore),
    compressionRatio,
    priceTightnessScore:Math.round(priceTightnessScore),
    tightnessPct,
    volumeDryUpScore:Math.round(volumeDryUpScore),
    volumeDryUpRatio,
    higherLowsScore:Math.round(higherLowsScore),
    breakoutProximityScore:Math.round(breakoutProximityScore),
    distanceTo5dHighPct,
    distanceTo20dHighPct,
    flowScore:Math.round(flowScore),
    relativeStrength5d:rs.relativeStrength5d,
    relativeStrength20d:rs.relativeStrength20d,
    relativeStrength60d:rs.relativeStrength60d,
    relativeStrengthAcceleration:rs.relativeStrengthAcceleration,
    relativeStrengthScore:Math.round(rs.score),
  };
}

module.exports = { setupFeatures };
