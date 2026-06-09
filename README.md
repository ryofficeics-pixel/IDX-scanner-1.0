# IDX Scanner 1.0

Production-ready Vercel MVP for IDX Flow Scanner.

## Routes

- `/` serves `public/index.html`
- `/api/idx-quotes` returns Yahoo Finance price-only quotes plus optional Supabase flow data
- `/api/flow-upload` upserts validated flow rows to Supabase when env vars are configured
- `/api/health` returns deployment health and Supabase configuration status

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

## Verification Checklist

- `npm run check`
- `vercel dev`, then open `/api/health`
- Open `/api/idx-quotes?symbols=BBCA,BBRI&force=true`
- Confirm Yahoo Finance quotes show `dataMode: "PRICE_ONLY"` when no flow exists
- Import CSV with `TradeDate`; accepted rows should become `FULL_FLOW` only when complete and current
- Confirm no BUY signal appears for `PRICE_ONLY`, `NO_DATA`, `LOCAL_SAMPLE`, or `FLOW_STALE`

