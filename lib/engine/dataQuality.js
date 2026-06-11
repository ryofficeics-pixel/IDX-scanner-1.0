'use strict';

function dataQualityScore(stockData) {
  const warnings = [];
  let score = 100;
  const price = Number(stockData.lastPrice);
  const prev = Number(stockData.previousClose);
  if (!Number.isFinite(price) || price <= 0) { score -= 45; warnings.push('Harga terakhir tidak valid'); }
  if (!Number.isFinite(prev) || prev <= 0) { score -= 35; warnings.push('Previous close tidak valid'); }
  if (Number.isFinite(stockData.dayHigh) && Number.isFinite(stockData.dayLow) && stockData.dayHigh < stockData.dayLow) {
    score -= 30; warnings.push('High harian lebih kecil dari low');
  }
  const ageMs = stockData.timestamp ? Date.now() - new Date(stockData.timestamp).getTime() : Infinity;
  if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) { score -= 20; warnings.push('Timestamp data stale'); }
  const changePct = prev > 0 && price > 0 ? ((price - prev) / prev) * 100 : null;
  if (changePct != null && Math.abs(changePct) > 35) { score -= 25; warnings.push('Perubahan harga tidak wajar'); }
  return { score:Math.max(0, Math.min(100, Math.round(score))), warnings };
}

module.exports = { dataQualityScore };
