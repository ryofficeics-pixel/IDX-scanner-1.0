# IDX Scanner 1.0

Production-ready Vercel app for IDX quote-driven scanning and recommendation filtering.

Production:

- https://idx-scanner-1-0.vercel.app

Repository:

- https://github.com/ryofficeics-pixel/IDX-scanner-1.0

## Routes

- `/` serves `public/index.html`
- `/api/scan` returns quote-driven recommendations without requiring CSV
- `/api/health` returns service, provider, session, scan, and cache status
- `/api/idx-quotes` remains available as a legacy quote endpoint
- `/api/flow-upload` optionally persists CSV broker flow rows to Supabase

CSV upload is optional and is only for broker-flow enrichment. The core scanner must work without CSV.

## Universe Coverage

The IDX universe is loaded from `data/idx-symbols.json` and currently contains 900+ symbols. The frontend scans the full universe in chunks of 300 symbols with limited concurrency so all issuers can be evaluated without rendering 900 cards at once or blocking tab navigation.

The UI renders a lighter active subset by default:

- current scan recommendations
- live quote results
- default liquid symbols
- user watchlist

Search can still query the wider universe.

## Provider Limitations

Primary provider:

- Yahoo Finance quote endpoint.

Fallback provider:

- Yahoo Finance chart endpoint per symbol.

Known behavior:

- Yahoo quote batches may return `HTTP 401` or rate-limit.
- The scanner falls back to chart data with concurrency limiting.
- If chart data also fails, the API returns structured `NO_DATA`.
- No fake prices, fake scores, random recommendations, or hardcoded recommendation output are used.

## Cache Behavior

Server cache:

- `/api/scan` caches scan results briefly in memory.
- Provider responses are cached briefly to reduce rate-limit pressure.
- API diagnostics include `cacheHit` and `cacheAgeMs`.

Client cache:

- The frontend stores the last successful scan in localStorage.
- Cache payload includes timestamp, marketDate, provider, and diagnostics.
- Corrupt localStorage is ignored safely.
- Old cache is never silently presented as live data.
- Previous-market-date cache is rendered as `Last saved snapshot`, not active recommendations.

## Stale Data Interpretation

The UI shows:

- `lastUpdated`
- `dataAgeMinutes`
- provider
- scan mode: `live`, `cache`, `stale`, `snapshot`, or `no-data`
- scanned/valid/noData/failed counts

If data age is greater than 15 minutes while the payload session is an IDX market-hours state, the UI shows:

```text
STALE DATA — DO NOT TRADE
```

## Debug Test Params

Debug fault injection only works when `debug=1`.

Supported `/api/scan` query params:

- `forceProviderFail=1`
- `forceQuoteFail=1`
- `forceChartFail=1`
- `mockTime=ISO_DATETIME`
- `mockProviderDelayMs=NUMBER`
- `corruptOneSymbol=1`

Examples:

```bash
/api/scan?symbols=BBCA,BBRI&debug=1
/api/scan?symbols=BBCA&debug=1&forceProviderFail=1
/api/scan?limit=120&debug=1&forceQuoteFail=1
/api/scan?symbols=BBCA&debug=1&mockTime=2026-06-11T02:30:00.000Z
```

## Diagnostics

`/api/scan` includes:

- `diagnostics.providerPrimaryStatus`
- `diagnostics.providerFallbackStatus`
- `diagnostics.providerLatencyMs`
- `diagnostics.cacheHit`
- `diagnostics.cacheAgeMs`
- `diagnostics.scanStartedAt`
- `diagnostics.scanFinishedAt`
- `diagnostics.dataFreshness`
- `diagnostics.failedSymbols`
- `diagnostics.validRatio`
- `diagnostics.noDataRatio`

`/api/health` includes:

- service/version/commit
- server time
- IDX session state
- last successful scan timestamp
- last scan valid count
- last scan failed count
- provider status summary
- cache status

## Signal Calculation Factors

Signals are calculated from live provider data and optional chart history. The engine does not use fake data or hardcoded recommendations.

Core scoring factors:

- price change versus previous close
- current volume versus average volume
- projected session volume adjusted by IDX session progress
- intraday trend from recent candles
- daily trend from SMA5 versus SMA20
- price position inside the daily high-low range
- VWAP distance when intraday volume candles are available
- 5-day and 20-day breakout proximity
- traded-value liquidity score
- provider data freshness
- gap-control score for excessive daily moves
- intraday volatility-control score
- IHSG market context

BUY and STRONG_BUY are gated by risk controls. A high raw score is not enough if the stock is illiquid, stale, far below VWAP, fading from the high, too volatile, or if market context is weak.

## Tests

Install dependencies:

```bash
npm install
```

Run syntax checks:

```bash
npm run check
```

Run API and signal sanity tests:

```bash
npm run test:api
```

Run Playwright E2E:

```bash
npm run test:e2e
```

Run stress tests:

```bash
npm run test:stress
```

Stress endpoints:

- `/api/health`
- `/api/scan?symbols=BBCA,BBRI,BMRI&debug=1`
- `/api/scan?limit=120&debug=1`

Acceptance threshold:

- Stress test must complete without more than 2% non-200 responses.

## Vercel Environment Variables

Optional, only needed for cloud flow persistence:

```env
SUPABASE_URL=https://mbjkpqxnbheatmtoodvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
```

Do not expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code.

## Supabase Table

Run this in the Supabase SQL editor before using `/api/flow-upload`:

```sql
CREATE TABLE IF NOT EXISTS idx_flow_data (
  symbol TEXT NOT NULL,
  trade_date DATE NOT NULL,
  broker_buy NUMERIC,
  broker_sell NUMERIC,
  foreign_buy NUMERIC,
  foreign_sell NUMERIC,
  net_buy NUMERIC,
  freq_buy INTEGER,
  freq_sell INTEGER,
  volume_avg5d NUMERIC,
  source TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (symbol, trade_date)
);
```

## Terminology

Price-volume signals are labeled as proxy signals.

- Use `Accumulation Proxy`.
- Use `Distribution Proxy`.
- Do not call price-volume proxy "broker accumulation".
- If broker flow is missing, the UI shows `Broker flow unavailable`.

## Known Limitations

- Yahoo Finance is not an official IDX market-data SLA provider.
- Provider rate limits or endpoint changes can affect availability.
- Server memory cache is per runtime instance and may reset between deployments or cold starts.
- Browser localStorage cache is device-specific.
- Broker flow requires optional CSV/Supabase data and is not required for core recommendations.
