# IDX Scanner Stockbit Gateway

Private, read-only HTTP adapter for the optional Stockbit enrichment in IDX Scanner. It wraps the public core exports from [`INo-xious/stockbit-mcp`](https://github.com/INo-xious/stockbit-mcp), pinned to version `1.3.0` under its MIT license.

The Vercel application remains serverless and calls this service only when enrichment is requested. This gateway itself must run as one persistent instance because Stockbit rotates its refresh token. Running several replicas against the same account can invalidate the active credential.

## Safety and limitations

- Only `stockbit-mcp/core` market-data functions are imported.
- `STOCKBIT_TRADING=off`, `STOCKBIT_TOOLS=core`, and `STOCKBIT_NO_BROWSER=1` are forced for the server process.
- The container exposes the port on host loopback only. Put an authenticated TLS reverse proxy in front of it for Vercel.
- The API accepts at most 20 symbols, rate-limits callers, serializes enrichment jobs, and returns only allowlisted normalized fields.
- Broker identities are end-of-day context, not live order flow. During an open session Stockbit can legitimately return empty broker rows.
- This uses Stockbit's undocumented private JSON API. It can change without notice and automated access may conflict with Stockbit's Terms of Use. Use only with your own account and at your own risk.
- The data is reference/confirmation material, not an order instruction or investment advice.

## Requirements

- A Linux VPS or other persistent Docker host
- Docker Engine with Compose
- A TLS hostname reachable by Vercel
- Your own Stockbit account/session

Do not deploy this directory as another Vercel function. The encrypted session store and stable hostname must survive restarts.

## 1. Configure

```bash
cd stockbit-gateway
cp .env.example .env
openssl rand -hex 32
```

Copy the generated random value into `STOCKBIT_GATEWAY_TOKEN` in `.env`. Use the same value later in Vercel. Do not commit `.env`.

Build the pinned image:

```bash
docker compose build
```

## 2. Authenticate once

The container intentionally has no browser. Use one of these two supported methods.

Paste an existing refresh token interactively:

```bash
docker compose run --rm gateway \
  node node_modules/stockbit-mcp/dist/bin/stockbit-auth.js bootstrap
```

Or capture a Stockbit username/password login as a HAR file in your local browser, copy that HAR temporarily to the server, then import it:

```bash
docker compose run --rm \
  -v "$PWD/login.har:/tmp/login.har:ro" \
  gateway node node_modules/stockbit-mcp/dist/bin/stockbit-auth.js \
  import-har /tmp/login.har
```

The HAR contains sensitive credentials and cookies in plain text. Delete your local and server copies securely after a successful import. Do not use `--verify` during setup unless you understand that verification rotates the token and logs out the related website session.

Check the stored session without spending a refresh:

```bash
docker compose run --rm gateway \
  node node_modules/stockbit-mcp/dist/bin/stockbit-auth.js \
  status --offline --json
```

Compose fixes the container hostname and user because the Linux file-store key is derived from both. Changing either makes an existing encrypted session unreadable. The named `stockbit_state` volume must also be backed up and retained.

## 3. Start and verify

```bash
docker compose up -d
docker compose ps
curl http://127.0.0.1:8787/health
```

Test the protected route from the host:

```bash
curl -X POST http://127.0.0.1:8787/v1/enrich \
  -H "Authorization: Bearer $STOCKBIT_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"symbols":["BBCA","BBRI"]}'
```

The public TLS proxy should forward only to `127.0.0.1:8787`. Do not publish port `8787` directly and do not log the `Authorization` header at the proxy.

## 4. Connect IDX Scanner

Set these server-side environment variables in the IDX Scanner Vercel project:

```env
STOCKBIT_GATEWAY_URL=https://your-private-gateway.example/v1/enrich
STOCKBIT_GATEWAY_TOKEN=<same-random-token>
STOCKBIT_GATEWAY_TIMEOUT_MS=9000
```

Redeploy IDX Scanner after changing environment variables. On each application open, the normal scan runs first and then requests optional enrichment for the relevant candidates. A Stockbit failure never blocks the core scanner or changes its score.

## Operations

```bash
docker compose logs --tail=100 gateway
docker compose restart gateway
docker compose run --rm gateway \
  node node_modules/stockbit-mcp/dist/bin/stockbit-auth.js \
  status --offline --json
```

If Stockbit returns `401` after the account has been inactive, repeat the authentication step. Keep a single running gateway instance for the account. Upgrade `stockbit-mcp` deliberately, review its changelog first, regenerate the lockfile, and run this directory's test suite before rebuilding.

## Local checks

```bash
npm ci
npm run check
npm test
```
