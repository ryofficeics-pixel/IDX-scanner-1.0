'use strict';

function structuredFailure(symbols, reason) {
  return {
    quotes: Object.fromEntries((symbols || []).map((symbol) => [symbol, {
      symbol,
      yahooSymbol: `${symbol}.JK`,
      lastPrice:null,
      previousClose:null,
      dayHigh:null,
      dayLow:null,
      volume:null,
      avgVolume20:null,
      timestamp:new Date().toISOString(),
      source:'none',
      error: reason || 'PROVIDER_UNAVAILABLE',
    }])),
    failedSymbols:[...(symbols || [])],
    warnings:[reason || 'Primary provider unavailable; no fake fallback generated'],
  };
}

module.exports = { structuredFailure };
