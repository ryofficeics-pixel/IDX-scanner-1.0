import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, tokenMatches } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const ENV_KEYS = [
  'STOCKBIT_GATEWAY_TOKEN',
  'HOST',
  'PORT',
  'STOCKBIT_GATEWAY_DETAIL_SYMBOL_LIMIT',
  'STOCKBIT_GATEWAY_SYMBOL_CONCURRENCY',
  'STOCKBIT_GATEWAY_RATE_LIMIT_PER_MINUTE',
  'STOCKBIT_GATEWAY_BROKER_PERIOD',
  'STOCKBIT_GATEWAY_FLOW_THRESHOLD_IDR',
];

function isolatedEnv(run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parses bearer authentication and compares token digests', () => {
  const token = 'a-secure-gateway-token-with-more-than-32-characters';
  assert.equal(bearerToken(`Bearer ${token}`), token);
  assert.equal(tokenMatches(`bearer ${token}`, token), true);
  assert.equal(tokenMatches('Basic abc', token), false);
  assert.equal(tokenMatches('Bearer wrong', token), false);
});

test('loads secure defaults and validates bounded gateway configuration', () => isolatedEnv(() => {
  process.env.STOCKBIT_GATEWAY_TOKEN = 'a-secure-gateway-token-with-more-than-32-characters';
  const config = loadConfig();
  assert.equal(config.port, 8787);
  assert.equal(config.detailSymbolLimit, 5);
  assert.equal(config.symbolConcurrency, 4);
  assert.equal(config.brokerPeriod, 'LAST_7_DAYS');
  assert.equal(config.flowThresholdIdr, 1_000_000_000);

  process.env.STOCKBIT_GATEWAY_BROKER_PERIOD = 'INVALID';
  assert.throws(() => loadConfig(), /must be one of/);
  process.env.STOCKBIT_GATEWAY_BROKER_PERIOD = 'LATEST';
  process.env.STOCKBIT_GATEWAY_SYMBOL_CONCURRENCY = '99';
  assert.throws(() => loadConfig(), /between 1 and 8/);
}));

test('refuses a missing or weak gateway token', () => isolatedEnv(() => {
  assert.throws(() => loadConfig(), /at least 32 characters/);
  process.env.STOCKBIT_GATEWAY_TOKEN = 'too-short';
  assert.throws(() => loadConfig(), /at least 32 characters/);
}));
