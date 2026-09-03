import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGatewayServer, internals } from '../src/app.js';

const TOKEN = 'test-token-that-is-longer-than-thirty-two-characters';

function config(overrides = {}) {
  return {
    token:TOKEN,
    rateLimitPerMinute:30,
    brokerPeriod:'LAST_7_DAYS',
    ...overrides,
  };
}

async function withServer(options, run) {
  const server = createGatewayServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('exposes a minimal public health endpoint and protects enrichment with bearer auth', async () => {
  await withServer({ config:config(), enrich:async () => ({ enrichments:{}, errors:[], detailedSymbols:[] }) }, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).readOnly, true);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.ok(health.headers.get('x-request-id'));

    const unauthorized = await fetch(`${base}/v1/enrich`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:'{"symbols":["BBCA"]}',
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error, 'UNAUTHORIZED');

    const wrongMethod = await fetch(`${base}/v1/enrich`, {
      method:'GET', headers:{ authorization:`Bearer ${TOKEN}` },
    });
    assert.equal(wrongMethod.status, 405);
  });
});

test('normalizes, deduplicates and validates requested symbols', async () => {
  let received;
  const enrich = async (symbols) => {
    received = symbols;
    return {
      enrichments:Object.fromEntries(symbols.map((symbol) => [symbol, { signal:'NEUTRAL' }])),
      errors:[], detailedSymbols:symbols.slice(0, 1),
    };
  };
  await withServer({ config:config(), enrich }, async (base) => {
    const response = await fetch(`${base}/v1/enrich`, {
      method:'POST',
      headers:{ authorization:`Bearer ${TOKEN}`, 'content-type':'application/json' },
      body:JSON.stringify({ symbols:['bbca.JK', 'BBCA', ' tlkm '] }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(received, ['BBCA', 'TLKM']);
    assert.deepEqual(body.matchedSymbols, ['BBCA', 'TLKM']);
    assert.equal(body.meta.readOnly, true);

    const invalid = await fetch(`${base}/v1/enrich`, {
      method:'POST',
      headers:{ authorization:`Bearer ${TOKEN}`, 'content-type':'application/json' },
      body:JSON.stringify({ symbols:['BBCA', '$BAD'] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'INVALID_SYMBOLS');
  });
});

test('rejects unsupported content and malformed JSON', async () => {
  await withServer({ config:config(), enrich:async () => ({ enrichments:{}, errors:[], detailedSymbols:[] }) }, async (base) => {
    const unsupported = await fetch(`${base}/v1/enrich`, {
      method:'POST', headers:{ authorization:`Bearer ${TOKEN}`, 'content-type':'text/plain' }, body:'{}',
    });
    assert.equal(unsupported.status, 415);

    const malformed = await fetch(`${base}/v1/enrich`, {
      method:'POST', headers:{ authorization:`Bearer ${TOKEN}`, 'content-type':'application/json' }, body:'{',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, 'INVALID_JSON');
  });
});

test('reports a complete upstream outage as a safe 502', async () => {
  const logs = [];
  const enrich = async () => ({
    enrichments:{},
    errors:[{ symbol:'BBCA', code:'broker:STOCKBIT_AUTH_FAILED' }],
    detailedSymbols:['BBCA'],
  });
  await withServer({ config:config(), enrich, logger:{ warn:(entry) => logs.push(entry) } }, async (base) => {
    const response = await fetch(`${base}/v1/enrich`, {
      method:'POST',
      headers:{ authorization:`Bearer ${TOKEN}`, 'content-type':'application/json' },
      body:JSON.stringify({ symbols:['BBCA'] }),
    });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.error, 'STOCKBIT_UPSTREAM_UNAVAILABLE');
    assert.equal(logs[0].event, 'stockbit_gateway_upstream_unavailable');
  });
});

test('serializes enrichment jobs and rate-limits authenticated requests', async () => {
  let now = 0;
  const limiter = internals.createRateLimiter(2, () => now);
  assert.equal(limiter(), true);
  assert.equal(limiter(), true);
  assert.equal(limiter(), false);
  now = 60_000;
  assert.equal(limiter(), true);

  let active = 0;
  let maximum = 0;
  const serialized = internals.serialize(async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value;
  });
  assert.deepEqual(await Promise.all([serialized(1), serialized(2), serialized(3)]), [1, 2, 3]);
  assert.equal(maximum, 1);
});
