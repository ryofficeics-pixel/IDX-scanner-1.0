'use strict';

const config = require('../config/signalConfig');

function scoredQuote(quote, prior = {}) {
  const price = Number(quote.lastPrice) || 0;
  const previous = Number(quote.previousClose) || 0;
  const volume = Number(quote.volume) || 0;
  const average = Number(quote.avgVolume20) || 0;
  const high = Number(quote.dayHigh) || price;
  const low = Number(quote.dayLow) || price;
  const tradedValue = price * volume;
  const changePct = previous > 0 ? ((price - previous) / previous) * 100 : Number(quote.changePct) || 0;
  const relativeVolume = average > 0 ? volume / average : 0;
  const rangePct = low > 0 ? ((high - low) / low) * 100 : 99;
  const nearHigh = high > 0 ? ((high - price) / high) * 100 : 99;
  const flowRatio = (Number(quote.netBuy) || 0) / Math.max(tradedValue, 1);
  const preMove = Math.max(0, 30 - Math.abs(changePct - 1) * 7)
    + Math.max(0, 16 - rangePct * 4)
    + Math.max(0, 12 - nearHigh * 3)
    + Math.min(18, Math.max(0, (relativeVolume - 0.5) * 12))
    + Math.min(12, Math.max(0, flowRatio * 100))
    + Math.min(25, Math.max(0, Number(prior.setupScore) - 50));
  return { quote, tradedValue, relativeVolume, changePct, preMove, priorScore:Number(prior.setupScore) || 0 };
}

function selectHistoryCandidates(quotes = [], priorStates = [], limit = config.historyCandidateLimit) {
  if (!(limit > 0)) return [];
  const prior = new Map(priorStates.map((state) => [state.symbol, state]));
  const rows = quotes.filter((quote) => quote?.symbol && Number(quote.lastPrice) > 0).map((quote) => scoredQuote(quote, prior.get(quote.symbol)))
    .filter((row) => row.tradedValue >= config.minimumTradedValue || row.quote.avgVolume20 * row.quote.lastPrice >= config.minimumTradedValue);
  const selected = new Map();
  const add = (items, count) => { let added = 0; for (const row of items) { if (added >= count || selected.size >= limit) break; if (!selected.has(row.quote.symbol)) { selected.set(row.quote.symbol, row.quote); added += 1; } } };
  const quota = Math.max(4, Math.floor(limit / 5));
  const tie = (a, b) => a.quote.symbol.localeCompare(b.quote.symbol);
  add([...rows].filter((row) => row.priorScore >= config.thresholds.setup).sort((a, b) => b.priorScore - a.priorScore || tie(a, b)), quota);
  add([...rows].sort((a, b) => b.preMove - a.preMove || tie(a, b)), quota * 2);
  add([...rows].sort((a, b) => b.tradedValue - a.tradedValue || tie(a, b)), quota);
  add([...rows].filter((row) => row.relativeVolume > 0).sort((a, b) => b.relativeVolume - a.relativeVolume || tie(a, b)), quota);
  if (selected.size < Math.min(limit, rows.length)) add([...rows].sort((a, b) => (b.preMove + Math.log10(Math.max(b.tradedValue, 1))) - (a.preMove + Math.log10(Math.max(a.tradedValue, 1)))), limit);
  return [...selected.values()].slice(0, limit);
}

module.exports = { selectHistoryCandidates };
