'use strict';

function marketRegime(market = {}, daily = []) {
  const change = Number(market.ihsgChangePct);
  const closes = daily.map((row) => Number(row.close)).filter((value) => value > 0);
  const returns = closes.slice(-21).map((value, i, rows) => i ? (value / rows[i - 1] - 1) * 100 : null).filter((value) => value != null);
  const average = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const volatility = market.ihsgVolatilityPct ?? (returns.length >= 10 ? Math.sqrt(returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / returns.length) : null);
  if (Number.isFinite(volatility) && volatility >= 2) return { regime:'high-volatility', scoreAdjustment:-5 };
  if (Number.isFinite(change) && change <= -1) return { regime:'bearish', scoreAdjustment:-5 };
  if (Number.isFinite(change) && change >= 0.7 && (closes.length < 20 || closes.at(-1) > closes.slice(-20).reduce((a, b) => a + b, 0) / 20)) return { regime:'bullish', scoreAdjustment:3 };
  return { regime:'neutral', scoreAdjustment:0 };
}

module.exports = { marketRegime };
