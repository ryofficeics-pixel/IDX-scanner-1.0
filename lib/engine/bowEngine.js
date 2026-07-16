'use strict';

const TI = require('technicalindicators');
const { clamp } = require('./indicators');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  const clean = values.map(num).filter((v) => v != null);
  return clean.length ? clean.reduce((sum, v) => sum + v, 0) / clean.length : null;
}

function pct(a, b) {
  a = num(a); b = num(b);
  return a != null && b > 0 ? ((a - b) / b) * 100 : null;
}

function movingAverage(closes, length) {
  if (closes.length < length) return null;
  return avg(closes.slice(-length));
}

function rsi(closes, length = 14) {
  if (closes.length < length + 1) return null;
  const r = TI.RSI.calculate({ values: closes, period: length });
  return r.length ? r[r.length - 1] : null;
}

function macd(closes) {
  if (closes.length < 33) return { macd:null, signal:null, histogram:null };
  const r = TI.MACD.calculate({ values: closes, fastPeriod:12, slowPeriod:26, signalPeriod:9 });
  const last = r.length ? r[r.length - 1] : null;
  return last ? { macd:last.MACD, signal:last.signal, histogram:last.histogram } : { macd:null, signal:null, histogram:null };
}

function bowCategory(score) {
  if (score >= 85) return 'Strong Buy On Weakness';
  if (score >= 70) return 'Buy Zone';
  if (score >= 55) return 'Watchlist';
  return 'Avoid';
}

function buildEntry(lastPrice, support) {
  if (!(lastPrice > 0) || !(support > 0)) return null;
  const stopLoss = support * 0.95;
  const risk = lastPrice - stopLoss;
  const target1 = lastPrice + risk * 2;
  const target2 = lastPrice + risk * 3;
  return {
    aggressiveEntry: Math.round(support),
    conservativeEntry: Math.round(lastPrice * 1.025),
    stopLoss: Math.round(stopLoss),
    target1: Math.round(target1),
    target2: Math.round(target2),
    riskReward: risk > 0 ? Number(((target1 - lastPrice) / risk).toFixed(2)) : null,
  };
}

function rsiScore(rsiVal) {
  if (rsiVal == null) return { raw: 0, weighted: 0, reason: 'RSI tidak tersedia' };
  const raw = clamp((40 - rsiVal) * 3.33, 0, 100);
  if (rsiVal >= 40) return { raw: 0, weighted: 0, reason: `RSI ${rsiVal.toFixed(1)} — belum cukup lemah` };
  if (rsiVal >= 35) return { raw, weighted: raw * 0.30, reason: `RSI ${rsiVal.toFixed(1)} — awal zona lemah` };
  if (rsiVal >= 30) return { raw, weighted: raw * 0.30, reason: `RSI ${rsiVal.toFixed(1)} — oversold moderat` };
  if (rsiVal >= 25) return { raw, weighted: raw * 0.30, reason: `RSI ${rsiVal.toFixed(1)} — oversold dalam` };
  return { raw: 95, weighted: 28.5, reason: `RSI ${rsiVal.toFixed(1)} — oversold ekstrem` };
}

function foreignScore(netBuy) {
  if (netBuy == null) return { raw: 0, weighted: 0, reason: 'Data foreign flow tidak tersedia' };
  const absVal = Math.abs(netBuy);
  const raw = netBuy > 0 ? clamp(absVal / 1e8 * 5, 0, 100) : 0;
  if (netBuy <= 0) return { raw: 0, weighted: 0, reason: 'Foreign net sell atau netral' };
  if (absVal > 1e10) return { raw: 100, weighted: 20, reason: `Foreign net buy Rp${(absVal/1e9).toFixed(1)}B — akumulasi sangat kuat` };
  if (absVal > 5e9) return { raw: raw, weighted: raw * 0.20, reason: `Foreign net buy Rp${(absVal/1e9).toFixed(1)}B — akumulasi kuat` };
  if (absVal > 1e9) return { raw: raw, weighted: raw * 0.20, reason: `Foreign net buy Rp${(absVal/1e9).toFixed(1)}B — akumulasi terdeteksi` };
  if (absVal > 2e8) return { raw: raw, weighted: raw * 0.20, reason: 'Foreign net buy kecil' };
  return { raw: 5, weighted: 1, reason: 'Foreign net buy minimal' };
}

function ma50DistanceScore(ma50, lastPrice) {
  if (ma50 == null || lastPrice == null) return { raw: 0, weighted: 0, pct: null, reason: 'MA50 tidak tersedia' };
  const distPct = ((lastPrice - ma50) / ma50) * 100;
  if (distPct < -3 || distPct > 2) return { raw: 0, weighted: 0, pct: distPct, reason: `Harga ${distPct > 0 ? '+' : ''}${distPct.toFixed(1)}% dari MA50 — di luar zona -3% s/d +2%` };
  const raw = clamp(100 - Math.abs(distPct) * 20, 0, 100);
  if (Math.abs(distPct) <= 0.5) return { raw, weighted: raw * 0.20, pct: distPct, reason: `Harga tepat di MA50 (${distPct.toFixed(1)}%) — support kuat` };
  return { raw, weighted: raw * 0.20, pct: distPct, reason: `Harga ${distPct > 0 ? '+' : ''}${distPct.toFixed(1)}% dari MA50 — masih di zona support` };
}

function volumeSurgeScore(todayVol, avgVol) {
  if (todayVol == null || avgVol == null || avgVol <= 0) return { raw: 0, weighted: 0, ratio: null, reason: 'Data volume tidak tersedia' };
  const vr = todayVol / avgVol;
  if (vr < 1.3) return { raw: 0, weighted: 0, ratio: vr, reason: `Volume ${vr.toFixed(2)}x — belum cukup surge (min 1.3x)` };
  const raw = clamp((vr - 1) * 100, 0, 100);
  if (vr >= 2.0) return { raw: 100, weighted: 15, ratio: vr, reason: `Volume ${vr.toFixed(2)}x rata-rata — akumulasi besar` };
  return { raw, weighted: raw * 0.15, ratio: vr, reason: `Volume ${vr.toFixed(2)}x rata-rata — mulai akumulasi` };
}

function relativeStrengthScore(stockReturn3M, ihsgReturn3M) {
  if (stockReturn3M == null || ihsgReturn3M == null || Math.abs(ihsgReturn3M) < 0.01) return { raw: 45, weighted: 6.75, reason: 'RS vs IHSG tidak dapat dihitung' };
  const rs = stockReturn3M / ihsgReturn3M;
  const raw = clamp(45 + (rs - 1) * 30, 0, 100);
  if (rs > 1.5) return { raw, weighted: raw * 0.15, reason: `RS ${rs.toFixed(2)}x — outperforms IHSG signifikan` };
  if (rs > 1) return { raw, weighted: raw * 0.15, reason: `RS ${rs.toFixed(2)}x — outperforms IHSG` };
  if (rs > 0.5) return { raw, weighted: raw * 0.15, reason: `RS ${rs.toFixed(2)}x — mulai outperforms IHSG` };
  return { raw, weighted: raw * 0.15, reason: `RS ${rs.toFixed(2)}x — masih underperform IHSG` };
}

function generateBowSignal(stock, marketContext = {}, histories = {}) {
  const daily = (histories.daily || []).filter((c) => num(c.close) != null);
  const closes = daily.map((c) => num(c.close));
  const reasons = [];
  const risks = [];
  const rejectReasons = [];
  const lastPrice = num(stock.lastPrice) ?? closes[closes.length - 1];
  const avgVolume20 = num(stock.avgVolume20) ?? avg(daily.slice(-20).map((c) => c.volume));
  const todayVolume = num(stock.volume);

  if (lastPrice == null || daily.length < 80) rejectReasons.push('Riwayat harga tidak cukup untuk BOW');

  const ma50 = movingAverage(closes, 50);
  const ma200 = movingAverage(closes, 200);
  const rsiVal = rsi(closes, 14);
  const recent = daily.slice(-63);
  const recentHigh = recent.length ? Math.max(...recent.map((c) => num(c.high) ?? num(c.close)).filter((v) => v != null)) : null;
  const drawdownPct = recentHigh && lastPrice ? ((recentHigh - lastPrice) / recentHigh) * 100 : null;

  // --- Gates ---
  const netBuy3d = num(stock.cumulative3dNetBuy);

  const gateCloseAboveMA200 = lastPrice > ma200;
  const gateRSI = rsiVal != null && rsiVal < 40;
  const gateMA50Prox = ma50 != null && lastPrice != null && ((lastPrice - ma50) / ma50) * 100 >= -3 && ((lastPrice - ma50) / ma50) * 100 <= 2;
  const gateDrawdown = drawdownPct != null && drawdownPct >= 10 && drawdownPct <= 20;
  const gateVolume = avgVolume20 > 0 && todayVolume != null && (todayVolume / avgVolume20) >= 1.3;
  const gateForeign = netBuy3d > 0 || (netBuy3d == null && (stock.netBuy == null || num(stock.netBuy) > 0));

  if (!gateCloseAboveMA200) rejectReasons.push('Close di bawah MA200 — trend jangka panjang turun');
  if (!gateRSI) rejectReasons.push(rsiVal != null ? `RSI ${rsiVal.toFixed(1)} — tidak memenuhi syarat < 40` : 'RSI tidak tersedia');
  if (!gateMA50Prox) {
    const dp = ma50 != null && lastPrice != null ? ((lastPrice - ma50) / ma50) * 100 : null;
    rejectReasons.push(dp != null ? `Harga ${dp > 0 ? '+' : ''}${dp.toFixed(1)}% dari MA50 — di luar zona -3% s/d +2%` : 'MA50 tidak tersedia');
  }
  if (!gateDrawdown) rejectReasons.push(drawdownPct != null ? `Drawdown ${drawdownPct.toFixed(1)}% — harus 10-20%` : 'Drawdown tidak dapat dihitung');
  if (!gateVolume) rejectReasons.push('Volume不足 — belum ada surge akumulasi (min 1.3x)');
  if (!gateForeign) rejectReasons.push('Foreign net sell — tidak ada akumulasi asing');

  // --- Scoring ---
  const rs = rsiScore(rsiVal);
  const fs = foreignScore(netBuy3d ?? num(stock.netBuy));
  const ms = ma50DistanceScore(ma50, lastPrice);
  const vs = volumeSurgeScore(todayVolume, avgVolume20);

  const stockReturn3M = closes.length > 63 && lastPrice ? pct(lastPrice, closes[closes.length - 64]) : null;
  const ihsgReturn3M = num(marketContext.ihsgReturn3M);
  const rss = relativeStrengthScore(stockReturn3M, ihsgReturn3M);

  const totalRaw = (rs.raw || 0) + (fs.raw || 0) + (ms.raw || 0) + (vs.raw || 0) + (rss.raw || 0);
  const totalWeighted = (rs.weighted || 0) + (fs.weighted || 0) + (ms.weighted || 0) + (vs.weighted || 0) + (rss.weighted || 0);
  let score = Math.round(totalWeighted + (rejectReasons.length ? -rejectReasons.length * 8 : 0));
  score = clamp(score);

  // --- Reasons ---
  if (gateCloseAboveMA200) reasons.push('Close > MA200 — uptrend jangka panjang');
  if (gateDrawdown) reasons.push(`Drawdown ${drawdownPct.toFixed(1)}% — zona pullback ideal`);
  if (gateMA50Prox) {
    const dp = ma50 != null && lastPrice != null ? ((lastPrice - ma50) / ma50) * 100 : 0;
    reasons.push(`Harga ${dp > 0 ? '+' : ''}${dp.toFixed(1)}% dari MA50 — support teknikal`);
  }
  if (gateRSI && rsiVal != null) reasons.push(`RSI ${rsiVal.toFixed(1)} — oversold/lemah`);
  if (gateVolume) {
    const vr = avgVolume20 > 0 && todayVolume != null ? todayVolume / avgVolume20 : 0;
    reasons.push(`Volume ${vr.toFixed(2)}x rata-rata — akumulasi bandar terdeteksi`);
  }
  const nbDisplay = netBuy3d ?? num(stock.netBuy);
  if (nbDisplay > 0) {
    const label = netBuy3d != null ? '3d kumulatif' : 'hari ini';
    reasons.push(`Foreign net buy Rp${(Math.abs(nbDisplay)/1e9).toFixed(2)}B (${label}) — asing akumulasi`);
  }
  if (rss.reason) reasons.push(rss.reason);
  if (vs.reason && !reasons.includes(vs.reason)) reasons.push(vs.reason);
  if (lastPrice != null) reasons.push('Harga belum bergerak — masih di zona BOW sebelum breakout');

  // --- Risks ---
  if (ma200 == null) risks.push('MA200 tidak tersedia');
  if (num(stock.marketCap) == null) risks.push('Market cap tidak tersedia');
  if (stock.netBuy == null) risks.push('Foreign flow tidak tersedia');

  // --- Entry model ---
  const support = [ma50, movingAverage(closes, 20)].filter((v) => v != null && v < lastPrice).sort((a, b) => b - a)[0] || ma50;
  const entryModel = buildEntry(lastPrice, support);

  // --- Morning boom (reuse) ---
  let boomScore = 0;
  let boomFactors = [];
  if (gateVolume && gateForeign && gateMA50Prox) {
    boomScore = vs.raw * 0.4 + (fs.raw || 0) * 0.3 + ms.raw * 0.3;
    boomScore = clamp(boomScore);
    if (vs.ratio != null && vs.ratio >= 1.5) boomFactors.push('volume surge tinggi');
    if (nbDisplay > 1e9) boomFactors.push('foreign akumulasi besar');
    if (ms.pct != null && Math.abs(ms.pct) <= 0.5) boomFactors.push('tepat di MA50');
  }

  return {
    symbol: stock.symbol,
    yahooSymbol: stock.yahooSymbol,
    name: stock.name || stock.symbol,
    lastPrice,
    score,
    category: bowCategory(score),
    verdict: bowCategory(score),
    action: score >= 55 && !rejectReasons.length ? 'BOW_BUY' : 'AVOID',
    drawdownPct,
    rsiDaily: rsiVal,
    ma50dist: ms.pct,
    volumeRatio: vs.ratio,
    netForeignBuy: num(stock.netBuy),
    cumulative3dNetBuy: netBuy3d,
    cumulative3dDays: stock.cumulative3dDays || null,
    trend: gateCloseAboveMA200 ? 'Uptrend' : 'Rejected',
    volume: gateVolume ? 'Surge akumulasi' : 'Tidak ada surge',
    entry: entryModel,
    morningBoom: boomScore > 0 ? { score: Math.round(boomScore), category: boomScore >= 65 ? 'High' : boomScore >= 50 ? 'Moderate' : 'Low', factors: boomFactors } : null,
    preMarketPlan: !rejectReasons.length && boomScore >= 50 ? {
      strategy: 'buy on weakness sebelum breakout',
      entryOpen: Math.round(lastPrice * 1.01),
      entryLimit: entryModel?.aggressiveEntry ?? null,
      stopLoss: entryModel?.stopLoss ?? null,
      target: entryModel?.target1 ?? null,
      conviction: boomScore >= 65 ? 'tinggi' : 'sedang',
    } : null,
    components: {
      rsiScore: Math.round(rs.raw || 0),
      foreignScore: Math.round(fs.raw || 0),
      ma50DistScore: Math.round(ms.raw || 0),
      volumeScore: Math.round(vs.raw || 0),
      rsScore: Math.round(rss.raw || 0),
      totalRaw: Math.round(totalRaw),
      totalWeighted: Math.round(totalWeighted),
    },
    signals: {
      rsi: rsiVal != null && rsiVal < 40,
      foreignAccumulation: num(stock.netBuy) > 0,
      nearMA50: gateMA50Prox,
      volumeSurge: gateVolume,
      drawdownZone: gateDrawdown,
      priceNotMoved: gateVolume && gateMA50Prox && rsiVal != null && rsiVal < 40,
    },
    reasons: reasons.length ? reasons : ['Belum memenuhi edge Buy on Weakness'],
    risks: risks.length ? risks : null,
    rejectReasons,
    warnings: [...risks, ...rejectReasons],
    source: stock.source || 'tradingview',
    timestamp: stock.timestamp || new Date().toISOString(),
  };
}

module.exports = { generateBowSignal };
