# IDX Scanner 1.0 Production Hardening Report

Date: 2026-06-11
Repository: https://github.com/ryofficeics-pixel/IDX-scanner-1.0
Production: https://idx-scanner-1-0.vercel.app

## Objective

Audit and harden the IDX Scanner 1.0 production app so it is safer, more observable, testable, and production-reliable without adding fake data or hardcoded recommendations.

## Scope Completed

### UI Data Freshness

Added visible scan metadata:

- lastUpdated
- dataAgeMinutes
- provider
- scan mode: live/cache/stale/snapshot/no-data
- scanned/valid/noData/failed counts
- cache age

Added safety behavior:

- If dataAgeMinutes is greater than 15 minutes during IDX market-hours state, UI shows `STALE DATA — DO NOT TRADE`.
- If cache marketDate is not today, cached data is rendered as `Last saved snapshot`, not active recommendation.
- Cache mode is explicit and never silently shown as live.

### API Diagnostics

Enhanced `/api/scan` diagnostics with:

- providerPrimaryStatus
- providerFallbackStatus
- providerLatencyMs
- cacheHit
- cacheAgeMs
- scanStartedAt
- scanFinishedAt
- dataFreshness
- failedSymbols
- validRatio
- noDataRatio

### Fault Injection

Added debug-only params for `/api/scan`:

- `forceProviderFail=1`
- `forceQuoteFail=1`
- `forceChartFail=1`
- `mockTime=ISO_DATETIME`
- `mockProviderDelayMs=NUMBER`
- `corruptOneSymbol=1`

These only work when `debug=1`.

### Cache Safety

Client localStorage now stores:

- payload
- savedAt timestamp
- marketDate
- provider
- diagnostics

Corrupt localStorage is safely ignored through safe JSON parsing.

### Health Endpoint

Updated `/api/health` to include:

- ok
- version/commit
- server time
- IDX session state
- last successful scan timestamp
- last scan valid count
- last scan failed count
- provider status summary
- cache status

### Tests

Added:

- API diagnostics tests
- Signal sanity tests
- Playwright E2E tests
- Autocannon stress tests
- Local test server for Vercel-style API handlers

### Terminology

Price-volume-only labels remain proxy labels.

- Use `Accumulation Proxy`.
- Use `Distribution Proxy`.
- Do not call price-volume proxy "broker accumulation".
- If broker flow is missing, UI shows `Broker flow unavailable`.

## Files Added

- `lib/runtime/scanState.js`
- `tests/localServer.js`
- `tests/api.test.js`
- `tests/signal.test.js`
- `tests/app.e2e.js`
- `tests/stress.js`
- `playwright.config.js`
- `project report.md`

## Files Updated

- `api/scan.js`
- `api/health.js`
- `lib/providers/yahooProvider.js`
- `lib/engine/signalEngine.js`
- `public/index.html`
- `package.json`
- `README.md`

## Exact Test Output

### npm run check

```text
> idx-scanner-1.0@2.0.0 check
> node --check api/idx-quotes.js && node --check api/flow-upload.js && node --check api/health.js && node --check api/scan.js && node --check lib/providers/yahooProvider.js && node --check lib/engine/signalEngine.js && node --check tests/api.test.js && node --check tests/signal.test.js && node --check tests/stress.js
```

Result: passed.

### npm run test:api

```text
> idx-scanner-1.0@2.0.0 test:api
> node --test tests/api.test.js tests/signal.test.js

✔ scan returns enhanced diagnostics (1484.4156ms)
✔ force provider fail returns no fake recommendations (2.0536ms)
✔ partial invalid symbols populate failedSymbols (1289.791ms)
✔ debug fault flags only work with debug=1 (962.5223ms)
✔ health exposes scan and cache status (0.6461ms)
✔ liquid strong momentum can become buy or strong buy (17.433ms)
✔ illiquid spike is rejected (0.5489ms)
✔ high volume fade becomes distribution proxy or risk (1.2645ms)
✔ no volume avoids buy recommendation (0.4697ms)
✔ low data quality reduces confidence (0.466ms)
✔ outside market hour blocks direct morning and afternoon labels (0.3773ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3817.9222
```

Result: passed.

### npm run test:e2e

```text
> idx-scanner-1.0@2.0.0 test:e2e
> playwright test

Running 8 tests using 1 worker

  ok 1 tests\app.e2e.js:47:1 › fresh open runs scan and does not require CSV (6.4s)
  ok 2 tests\app.e2e.js:58:1 › scan success renders metadata and signal area (1.1s)
  ok 3 tests\app.e2e.js:67:1 › API failure with cache renders cached result as cache mode (1.1s)
  ok 4 tests\app.e2e.js:76:1 › API failure without cache does not crash (1.1s)
  ok 5 tests\app.e2e.js:84:1 › stale cache warning appears (1.0s)
  ok 6 tests\app.e2e.js:93:1 › corrupt localStorage recovers (1.0s)
  ok 7 tests\app.e2e.js:100:1 › mobile viewport remains usable (1.2s)
  ok 8 tests\app.e2e.js:107:1 › empty TOP BUY state is explicit (1.2s)

  8 passed (15.0s)
```

Result: passed.

### npm run test:stress

```text
> idx-scanner-1.0@2.0.0 test:stress
> node tests/stress.js

/api/health requests=26610 non2xx=0 ratio=0.00%
/api/scan?symbols=BBCA,BBRI,BMRI&debug=1 requests=15425 non2xx=0 ratio=0.00%
/api/scan?limit=120&debug=1 requests=1140 non2xx=0 ratio=0.00%
```

Result: passed. Non-200 ratio stayed below the 2% threshold for every endpoint.

## Current Known Limitations

- Yahoo Finance is not an official IDX market-data SLA provider.
- Yahoo quote endpoint can return HTTP 401; chart fallback is used.
- Server memory cache is per runtime instance and can reset on cold start.
- Browser cache is local to each device.
- Broker flow remains optional and requires CSV/Supabase data.

## Deployment

Production URL:

- https://idx-scanner-1-0.vercel.app

Deployment status:

- Completed.

Latest deployed commit:

- `4b2c2c1` - `Harden production scan observability and tests`

Vercel deployment:

- `https://idx-scanner-1-0-9po4btxl0-estora-v1.vercel.app`
- Production alias: `https://idx-scanner-1-0.vercel.app`

## Live Verification After Deployment

### /api/health

```json
{"ok":true,"version":"4b2c2c1","session":"AFTERNOON","providerStatus":"unknown","cache":"empty"}
```

The health route includes last scan fields. On Vercel, route memory is per runtime instance, so last scan fields can be `null` until available in that route instance.

### /api/scan?symbols=BBCA,BBRI,BMRI&debug=1

```json
{"ok":true,"scanned":3,"valid":3,"noData":0,"failed":0,"primary":"error","fallback":"ok","validRatio":1,"noDataRatio":0,"freshness":"live"}
```

### /api/scan?symbols=BBCA&debug=1&forceProviderFail=1

```json
{"ok":true,"valid":0,"noData":1,"fakePrices":0,"primary":"error","fallback":"error","freshness":"no-data"}
```

### Production HTML Checks

```json
{"hasLastUpdated":true,"hasDataAge":true,"hasMode":true,"hasStaleWarning":true,"hasBrokerFlowUnavailable":true,"hasOldCsvWarning":false}
```

### Git Sync

```text
## main...origin/main
0 0
```
