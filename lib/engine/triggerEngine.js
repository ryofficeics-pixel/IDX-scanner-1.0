'use strict';

const { clamp } = require('./indicators');
const { number, dayKey, minuteOfDay, partitionIntraday, BAR_MS } = require('../market/historyContext');
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (current, prior) => prior > 0 ? (current / prior - 1) * 100 : 0;
const volumeTables = new WeakMap();

function volumeTable(day) {
  const signature = JSON.stringify(day.map((bar) => [bar.timestamp, bar.volume]));
  const cached = volumeTables.get(day);
  if (cached?.signature === signature) return cached;
  const slots = new Map();
  let volume = 0;
  for (const bar of day) {
    const priorVolume = volume;
    volume += number(bar.volume, 0);
    slots.set(minuteOfDay(bar.timestamp), { volume, priorVolume });
  }
  const result = { signature, date:day.length ? dayKey(day[0].timestamp) : null,
    hasOpen:day.length > 0 && minuteOfDay(day[0].timestamp) === 540, slots };
  volumeTables.set(day, result);
  return result;
}

function vwapAt(bars, end = bars.length) {
  let value = 0;
  let volume = 0;
  for (const bar of bars.slice(0, end)) {
    const size = number(bar.volume, 0);
    const typical = (number(bar.high, number(bar.close, 0)) + number(bar.low, number(bar.close, 0)) + number(bar.close, 0)) / 3;
    value += typical * size;
    volume += size;
  }
  return volume > 0 ? value / volume : null;
}

function openingRange(bars, minutes, session) {
  const dates = new Set(bars.filter((bar) => bar.timestamp).map((bar) => dayKey(bar.timestamp)));
  const range = bars.filter((bar) => bar.timestamp && minuteOfDay(bar.timestamp) >= 540 && minuteOfDay(bar.timestamp) < 540 + minutes);
  const slots = new Set(range.map((bar) => minuteOfDay(bar.timestamp)));
  const complete = dates.size === 1 && Array.from({ length:minutes / 5 }, (_, i) => 540 + i * 5).every((slot) => slots.has(slot));
  const high = complete ? Math.max(...range.map((bar) => bar.high)) : null;
  const low = complete ? Math.min(...range.map((bar) => bar.low)) : null;
  const last = bars.at(-1);
  const previous = bars.at(-2);
  const breakout = Boolean(complete && session.status === 'MORNING' && last?.timestamp && minuteOfDay(last.timestamp) >= 540 + minutes
    && last.close > high && previous?.close <= high);
  return { complete, high, low, widthPct:complete ? pct(high, low) : null, volume:complete ? range.reduce((sum, bar) => sum + bar.volume, 0) : null, breakout };
}

function triggerFeatures(stock, rows = [], session = {}, baselineDays = []) {
  const bars = rows.filter((bar) => number(bar.close) > 0);
  const last = bars.at(-1);
  const previous = bars.at(-2);
  const length = bars.length;
  const span = Math.min(3, Math.floor((length - 1) / 2));
  const contiguous = span > 0 && bars.slice(-(2 * span + 1)).every((bar, i, window) => !bar.timestamp || !i || new Date(bar.timestamp) - new Date(window[i - 1].timestamp) === BAR_MS);
  const priceVelocity = contiguous ? pct(last.close, bars[length - 1 - span].close) / span : 0;
  const priorVelocity = contiguous ? pct(bars[length - 1 - span].close, bars[length - 1 - 2 * span].close) / span : 0;
  const priceAcceleration = priceVelocity - priorVelocity;
  const volumes = bars.map((bar) => number(bar.volume, 0));
  const recentVol = mean(volumes.slice(-2));
  const priorVol = mean(volumes.slice(-6, -2));
  const volumeAcceleration = priorVol > 0 && contiguous ? recentVol / priorVol : null;
  const now = session.now || (last?.timestamp ? new Date(new Date(last.timestamp).getTime() + BAR_MS) : null);
  const clockMinute = last?.timestamp ? minuteOfDay(last.timestamp) : null;
  const currentDate = now ? dayKey(now) : null;
  const sameTime = now && last?.timestamp ? baselineDays.map(volumeTable).filter((table) => table.date && table.date < currentDate).map((table) => {
    // Require opening and current clock-slot coverage; missing provider bars must not depress the baseline.
    return table.hasOpen ? table.slots.get(clockMinute) : null;
  }).filter((row) => row?.volume > 0) : [];
  const cumulativeVolume = volumes.reduce((sum, value) => sum + value, 0);
  const expected = sameTime.length >= 3 ? mean(sameTime.map((row) => row.volume)) : null;
  const priorExpected = sameTime.length >= 3 ? mean(sameTime.map((row) => row.priorVolume)) : null;
  const timeOfDayVolumeRatio = expected > 0 ? cumulativeVolume / expected : null;
  const relativeVolumeAcceleration = priorExpected > 0 ? timeOfDayVolumeRatio - (cumulativeVolume - volumes.at(-1)) / priorExpected : null;

  const vwap = vwapAt(bars);
  const priorVwap = vwapAt(bars, Math.max(0, length - 1));
  const earlierVwap = vwapAt(bars, Math.max(0, length - 2));
  const vwapReclaim = Boolean(previous && priorVwap > 0 && previous.close < priorVwap && last.close >= vwap);
  const vwapBounce = Boolean(previous && vwap > 0 && number(last.low) > 0 && last.low <= vwap * 1.002 && last.close > vwap && last.close > number(last.open, last.close));
  const vwapSlopePositive = Boolean(earlierVwap > 0 && vwap > priorVwap && priorVwap <= earlierVwap);
  const vwapRejection = Boolean(previous && vwap > 0 && number(last.high) >= vwap && last.close < vwap && last.close < number(last.open, last.close));
  const vwapHolding = Boolean(vwap > 0 && Math.abs(pct(last.close, vwap)) < 0.5 && volumeAcceleration >= 1.3);
  const or15 = openingRange(bars, 15, session);
  const or30 = openingRange(bars, 30, session);
  const range = or30.complete ? or30 : or15;
  const history = bars.slice(-7, -1);
  const resistance = history.length >= 3 ? Math.max(...history.map((bar) => number(bar.high, bar.close))) : null;
  const microBreakout = Boolean(resistance && last.close > resistance && previous.close <= resistance);
  const priorHistory = bars.slice(-8, -2);
  const priorResistance = priorHistory.length >= 3 ? Math.max(...priorHistory.map((bar) => number(bar.high, bar.close))) : null;
  const failedBreakout = Boolean(priorResistance && previous.close > priorResistance && last.close < priorResistance);
  const lastRange = last ? number(last.high, last.close) - number(last.low, last.close) : 0;
  const upperWickRatio = lastRange > 0 ? (last.high - Math.max(last.close, number(last.open, last.close))) / lastRange : 0;
  const oneBarPriceSpike = Boolean(previous && pct(last.close, previous.close) >= 5);
  const oneBarVolumeSpike = Boolean(priorVol > 0 && volumes.at(-1) / priorVol >= 6 && volumes.at(-2) < priorVol * 1.2);
  const rejectionPenalty = (failedBreakout ? 35 : 0) + (upperWickRatio > 0.6 ? 20 : 0) + (vwapRejection ? 15 : 0) + (oneBarPriceSpike ? 15 : 0) + (oneBarVolumeSpike ? 10 : 0);
  const velocityScore = clamp(35 + Math.max(0, priceVelocity) * 80 + priceAcceleration * 100);
  const volumeAccelerationScore = volumeAcceleration == null ? 0 : clamp(35 + (volumeAcceleration - 1) * 35 + (relativeVolumeAcceleration ?? 0) * 40);
  const vwapTransitionScore = clamp(25 + (vwapReclaim ? 40 : 0) + (vwapBounce ? 25 : 0) + (vwapSlopePositive ? 15 : 0) + (vwapHolding ? 15 : 0));
  const openingRangeBreakout = or15.breakout || or30.breakout;
  const microBreakoutScore = clamp(25 + (microBreakout ? 45 : 0) + (openingRangeBreakout ? 30 : 0));
  const baseBars = bars.slice(-7, -1);
  const intradayBaseWidthPct = baseBars.length >= 4 ? pct(Math.max(...baseBars.map((bar) => number(bar.high, bar.close))), Math.min(...baseBars.map((bar) => number(bar.low, bar.close)))) : null;
  const intradaySetupScore = intradayBaseWidthPct == null ? 0 : clamp(100 - intradayBaseWidthPct * 20);
  const triggerScore = length >= 3 ? Math.round(clamp(velocityScore * 0.30 + volumeAccelerationScore * 0.28 + vwapTransitionScore * 0.22 + microBreakoutScore * 0.20 - rejectionPenalty)) : 0;
  return {
    triggerScore, earlyMomentumScore:triggerScore, priceVelocity, priceAcceleration,
    volumeAcceleration, volumeAccelerationScore, relativeVolumeAcceleration, timeOfDayVolumeRatio,
    projectedVolumeSource:timeOfDayVolumeRatio == null ? 'session-curve' : 'historical-time-of-day',
    volumeBaselineDays:sameTime.length, vwapReclaim, vwapBounce, vwapSlopePositive, vwapRejection, vwapHolding,
    openingRange15:or15, openingRange30:or30, openingRangeHigh:range.high, openingRangeLow:range.low,
    openingRangeWidthPct:range.widthPct, openingRangeBreakout,
    openingRangeCompression:range.complete && range.widthPct <= 2, openingRangeVolume:range.volume,
    microBreakout, microBreakoutScore, intradayBaseWidthPct, intradaySetupScore, failedBreakout, upperWickRatio, oneBarPriceSpike, oneBarVolumeSpike,
    falseBreakoutPenalty:rejectionPenalty, triggerHistoryAvailable:length >= 3,
  };
}

module.exports = { partitionIntraday, triggerFeatures, vwapAt, openingRange };
