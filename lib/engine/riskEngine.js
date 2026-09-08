'use strict';

const { clamp } = require('./indicators');
const config = require('../config/signalConfig');

function riskProfile(stock, indicators, marketContext = {}) {
  const warnings = [];
  const liquidityRisk = clamp(
    indicators.tradedValue < config.minimumTradedValue ? 100
      : indicators.tradedValue < 2e9 ? 70
      : indicators.tradedValue < 5e9 ? 45
      : 15
  );
  const dataRisk = clamp(
    indicators.freshnessScore < 55 ? 100
      : indicators.freshnessScore < 82 ? 55
      : Number(stock.lastPrice) > 0 && Number(stock.previousClose) > 0 ? 10 : 100
  );
  const volatilityRisk = clamp(
    Math.max(0, indicators.dayRangePct - Math.abs(indicators.changePct)) * 7
    + Math.max(0, (indicators.upperWickRatio || 0) - 0.45) * 80
  );
  const chaseRisk = clamp(indicators.chasePenalty || 0);
  const marketRisk = clamp(25 - (Number(marketContext.ihsgChangePct) || 0) * 22);
  const falseBreakoutRisk = clamp(
    (indicators.failedBreakout ? 100 : 0)
    + (indicators.oneBarPriceSpike ? 35 : 0)
    + (indicators.oneBarVolumeSpike ? 25 : 0)
  );
  const riskScore = Math.round(clamp(
    liquidityRisk * 0.25
    + dataRisk * 0.25
    + volatilityRisk * 0.15
    + chaseRisk * 0.18
    + marketRisk * 0.07
    + falseBreakoutRisk * 0.10
  ));

  if (liquidityRisk >= 100) warnings.push('Nilai transaksi sangat rendah');
  else if (liquidityRisk >= 70) warnings.push('Nilai transaksi rendah');
  if ((Number(stock.volume) || 0) < 100000) warnings.push('Volume rendah');
  if (stock.timestampSource === 'fetch') warnings.push('Waktu transaksi belum terverifikasi; waktu pengambilan bukan waktu transaksi');
  else if (dataRisk >= 100) warnings.push('Data provider tertinggal lebih dari 30 menit');
  else if (dataRisk >= 55) warnings.push('Data provider tertinggal lebih dari 15 menit');
  if (indicators.lateFadeScore > 45) warnings.push('Late fade terdeteksi');
  if (!indicators.intradayMA) warnings.push('Intraday candle tidak tersedia');
  if (indicators.failedBreakout) warnings.push('Breakout gagal dan harga kembali di bawah resistance');
  if (indicators.oneBarPriceSpike || indicators.oneBarVolumeSpike) warnings.push('Lonjakan satu bar belum memiliki kelanjutan');
  if (chaseRisk >= 45) warnings.push('Harga kuat tetapi titik masuk sudah terlalu jauh');
  if (volatilityRisk >= 65) warnings.push('Range intraday terlalu lebar');
  if (indicators.vwapDistancePct != null && indicators.vwapDistancePct < -1.2) warnings.push('Harga di bawah VWAP');
  if (marketRisk >= 45) warnings.push('Konteks IHSG lemah');

  const hardHigh = liquidityRisk >= 100
    || (Number(stock.volume) || 0) < 100000
    || dataRisk >= 100
    || indicators.failedBreakout
    || falseBreakoutRisk >= 100
    || (indicators.lateFadeScore >= 80 && indicators.rangePosition < 0.35)
    || (stock.bid > 0 && stock.ask > stock.bid * 1.03);
  const level = hardHigh || riskScore >= 58 ? 'HIGH' : riskScore >= 32 ? 'MEDIUM' : 'LOW';
  return {
    penalty:Math.round(clamp(riskScore * 0.35, 0, 35)),
    riskScore,
    level,
    warnings,
    riskComponents:{ market:Math.round(marketRisk), liquidity:Math.round(liquidityRisk), data:Math.round(dataRisk), volatility:Math.round(volatilityRisk), chase:Math.round(chaseRisk), structure:Math.max(Math.round(falseBreakoutRisk), Math.round(indicators.lateFadeScore || 0)) },
  };
}

module.exports = { riskProfile };
