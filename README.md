# IDX Scanner 1.0

Production-ready Vercel app for IDX quote-driven scanning and recommendation filtering.

Production:

- https://idx-scanner-1-0.vercel.app

Repository:

- https://github.com/ryofficeics-pixel/IDX-scanner-1.0

## Routes

- `/` serves `public/index.html`
- `/api/scan` returns quote-driven recommendations without requiring CSV
- `/api/enrich?symbols=BBCA,BBRI` fetches optional Telmi and Stockbit confirmation data on demand
- `/api/health` returns service, provider, session, scan, and cache status
- `/api/idx-quotes` remains available as a legacy quote endpoint
- `/api/flow-upload` optionally persists CSV broker flow rows to Supabase

CSV upload is optional and is only for broker-flow enrichment. The core scanner must work without CSV.

## Sync on Open

The browser starts one core scan when the application is opened. After the scan is ready, `/api/enrich` is requested only for up to 20 relevant candidates (recommendations first, then watchlist). The default repeat interval is `Saat buka` (`0`), which means no background polling after that initial sync. Users can optionally select a 1, 5, or 15 minute repeat interval while the tab remains open.

This design matches serverless execution: no always-on worker is required. A manual `Force Sync`, an external-data refresh, or opening a detail that has not yet been enriched creates a new request.

## Optional External Enrichment

External data is deliberately separated from the core signal engine:

- Telmi Finance uses the official Open API and can contribute stock signals and top-pick fundamentals.
- Stockbit is supported through a user-operated read-only gateway. Persistent Stockbit authentication stays outside Vercel and outside browser code.
- External data is shown as confirmation/contrast in the `External` detail tab.
- External values never modify the core scanner score, recommendation gates, or risk controls.
- No endpoint in this project places, modifies, or cancels an order.

Provider failures are non-fatal. `/api/enrich` still returns a structured result when a provider is disabled, restricted by its subscription plan, or temporarily unavailable; `/api/scan` continues independently.

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
- Telmi datasets are cached for five minutes per warm runtime; Stockbit gateway requests are cached for two minutes per symbol set.

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

All integrations below are optional:

```env
TELMI_API_KEY=
TELMI_API_BASE_URL=https://api-finance.telmi.id/api/v1/open

STOCKBIT_GATEWAY_URL=https://your-read-only-gateway.example/v1/enrich
STOCKBIT_GATEWAY_TOKEN=

SUPABASE_URL=https://mbjkpqxnbheatmtoodvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
```

Never expose any API key, service-role key, Stockbit session, or gateway token in frontend code. Store them only as server-side Vercel environment variables.

Telmi endpoints used by the provider:

- `GET /market/stock-signals`
- `GET /stocks/top-picks`

Some Telmi endpoints can require a higher subscription tier. That is reported as `partial` or `error`; it does not break the core scan.

### Stockbit gateway contract

`STOCKBIT_GATEWAY_URL` must accept:

```http
POST /v1/enrich
Authorization: Bearer <STOCKBIT_GATEWAY_TOKEN>
Content-Type: application/json

{"symbols":["BBCA","BBRI"]}
```

It may return either an `enrichments` object, a `data` object, or a `data` array. Recommended normalized response:

```json
{
  "ok": true,
  "enrichments": {
    "BBCA": {
      "sentiment": "bullish",
      "summary": "Broker flow positive",
      "brokerSummary": {
        "netBuyValue": 1250000000,
        "topBuyers": [{ "broker": "YP", "value": 800000000 }]
      },
      "orderbook": {
        "imbalance": 18.4,
        "bestBid": 9575,
        "bestOffer": 9600
      },
      "fundamentals": { "pe": 18.2, "pbv": 4.1 }
    }
  }
}
```

The server applies an allowlist before returning gateway data to the browser. Unknown fields are discarded.

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
- Telmi usefulness and coverage depend on the configured Telmi plan and current API response.
- Stockbit enrichment remains disabled until a separate authenticated read-only gateway is configured.
- External confirmation can disagree with the core scanner; disagreement is displayed as `SUMBER BERBEDA ARAH`, not silently averaged into a score.
