'use strict';

const { clamp } = require('./indicators');

function riskProfile(stock, indicators, marketContext = {}) {
  const warnings = [];
  let penalty = 0;
  if (indicators.tradedValue < 5e8) { penalty += 18; warnings.push('Nilai transaksi sangat rendah'); }
  else if (indicators.tradedValue < 2e9) { penalty += 10; warnings.push('Nilai transaksi rendah'); }
  if ((stock.volume || 0) < 100000) { penalty += 12; warnings.push('Volume rendah'); }
  if (Math.abs(indicators.changePct) > 8) { penalty += 12; warnings.push('Perubahan harga ekstrem'); }
  if (indicators.rangePosition < 0.45) { penalty += 10; warnings.push('Harga lemah di range harian'); }
  if (indicators.lateFadeScore > 45) { penalty += 12; warnings.push('Late fade terdeteksi'); }
  if (!indicators.intradayMA) { penalty += 6; warnings.push('Intraday candle tidak tersedia'); }
  if (indicators.volumeRatio < 0.2) { penalty += 8; warnings.push('Volume jauh di bawah rata-rata'); }
  if (indicators.changePct > 5 && indicators.projectedVolRatio < 0.8) { penalty += 12; warnings.push('Price spike tanpa dukungan volume'); }
  if (indicators.liquidityScore < 35) { penalty += 12; warnings.push('Likuiditas rendah'); }
  if (indicators.dataAgeMinutes != null && indicators.dataAgeMinutes > 30) { penalty += 14; warnings.push('Data provider tertinggal lebih dari 30 menit'); }
  else if (indicators.dataAgeMinutes != null && indicators.dataAgeMinutes > 15) { penalty += 8; warnings.push('Data provider tertinggal lebih dari 15 menit'); }
  if (indicators.dayRangePct > 14) { penalty += 10; warnings.push('Range intraday terlalu lebar'); }
  if (indicators.vwapDistancePct != null && indicators.vwapDistancePct < -1.2) { penalty += 10; warnings.push('Harga di bawah VWAP'); }
  if (marketContext.ihsgChangePct != null && marketContext.ihsgChangePct < -0.8) { penalty += 8; warnings.push('Konteks IHSG lemah'); }
  const level = penalty >= 32 ? 'HIGH' : penalty >= 16 ? 'MEDIUM' : 'LOW';
  return { penalty:clamp(penalty, 0, 60), level, warnings };
}

module.exports = { riskProfile };
