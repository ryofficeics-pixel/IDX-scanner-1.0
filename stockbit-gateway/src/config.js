const PERIODS = new Set(['LATEST', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_3_MONTHS', 'YEAR_TO_DATE']);

function integer(name, fallback, { min, max }) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function finiteNumber(name, fallback, { min, max }) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig() {
  const token = String(process.env.STOCKBIT_GATEWAY_TOKEN || '').trim();
  if (token.length < 32) {
    throw new Error('STOCKBIT_GATEWAY_TOKEN must contain at least 32 characters');
  }

  const brokerPeriod = String(process.env.STOCKBIT_GATEWAY_BROKER_PERIOD || 'LAST_7_DAYS').trim().toUpperCase();
  if (!PERIODS.has(brokerPeriod)) {
    throw new Error(`STOCKBIT_GATEWAY_BROKER_PERIOD must be one of ${Array.from(PERIODS).join(', ')}`);
  }

  return {
    token,
    host:String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0',
    port:integer('PORT', 8787, { min:1, max:65535 }),
    detailSymbolLimit:integer('STOCKBIT_GATEWAY_DETAIL_SYMBOL_LIMIT', 5, { min:0, max:20 }),
    symbolConcurrency:integer('STOCKBIT_GATEWAY_SYMBOL_CONCURRENCY', 4, { min:1, max:8 }),
    rateLimitPerMinute:integer('STOCKBIT_GATEWAY_RATE_LIMIT_PER_MINUTE', 30, { min:1, max:600 }),
    brokerPeriod,
    flowThresholdIdr:finiteNumber('STOCKBIT_GATEWAY_FLOW_THRESHOLD_IDR', 1_000_000_000, { min:0, max:1_000_000_000_000_000 }),
  };
}
