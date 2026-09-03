import {
  mergeNormalized,
  normalizeBrokerSummary,
  normalizeFundamentals,
  normalizeOrderbook,
  normalizeQuote,
} from './normalize.js';

function errorCode(error) {
  const status = Number(error?.status);
  if (error?.kind === 'auth' || status === 401) return 'STOCKBIT_AUTH_FAILED';
  if (status === 403) return 'STOCKBIT_FORBIDDEN';
  if (status === 429) return 'STOCKBIT_RATE_LIMITED';
  if (error?.kind === 'challenge') return 'STOCKBIT_CHALLENGE';
  return 'STOCKBIT_SOURCE_FAILED';
}

async function mapLimit(items, limit, run) {
  const output = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length:Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await run(items[current], current);
    }
  });
  await Promise.all(workers);
  return output;
}

async function settled(label, run) {
  try {
    return { label, ok:true, value:await run() };
  } catch (error) {
    return { label, ok:false, code:errorCode(error) };
  }
}

function normalizedFrom(results, config) {
  const byLabel = Object.fromEntries(results.filter((result) => result.ok).map((result) => [result.label, result.value]));
  return mergeNormalized(
    normalizeBrokerSummary(byLabel.broker, { thresholdIdr:config.flowThresholdIdr, period:config.brokerPeriod }),
    normalizeQuote(byLabel.quote),
    normalizeOrderbook(byLabel.orderbook, byLabel.quote),
    normalizeFundamentals(byLabel.keystats),
  );
}

export function createEnrichmentService(api, config) {
  for (const name of ['getBrokerSummary', 'getQuote', 'getOrderbook', 'getKeystats']) {
    if (typeof api?.[name] !== 'function') throw new Error(`Stockbit core export ${name} is required`);
  }

  return async function enrich(symbols) {
    const rows = await mapLimit(symbols, config.symbolConcurrency, async (symbol, index) => {
      const detailed = index < config.detailSymbolLimit;
      const tasks = [settled('broker', () => api.getBrokerSummary({ symbol, period:config.brokerPeriod }))];
      if (detailed) {
        tasks.push(
          settled('quote', () => api.getQuote(symbol)),
          settled('orderbook', () => api.getOrderbook(symbol)),
          settled('keystats', () => api.getKeystats(symbol)),
        );
      }
      const results = await Promise.all(tasks);
      const value = normalizedFrom(results, config);
      const errors = results.filter((result) => !result.ok).map((result) => `${result.label}:${result.code}`);
      return { symbol, value, errors, detailed };
    });

    const enrichments = {};
    const errors = [];
    for (const row of rows) {
      if (Object.keys(row.value).length) enrichments[row.symbol] = row.value;
      for (const code of row.errors) errors.push({ symbol:row.symbol, code });
    }
    return { enrichments, errors, detailedSymbols:rows.filter((row) => row.detailed).map((row) => row.symbol) };
  };
}

export const internals = { errorCode, mapLimit, settled, normalizedFrom };
