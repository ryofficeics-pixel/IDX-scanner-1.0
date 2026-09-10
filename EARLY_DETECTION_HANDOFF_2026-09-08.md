# IDX early-detection overhaul — 8 September 2026

Historical 07:10 WIB checkpoint. Work subsequently resumed at the user's request. See [the final engineering report](EARLY_DETECTION_REPORT_2026-09-08.md) for current results and delivery status; the observations below describe the earlier V3 candidate.

## Verdict and stop condition

**INCOMPLETE. EXPERIMENTAL. DO NOT DEPLOY THIS SIGNAL REVISION.** Work stopped for the user's 07:10 WIB cutoff. Local source changes are saved; nothing was committed, pushed, or deployed. The latest candidate detects some runners earlier, but loses recall and produces substantially more false positives. Passing software tests does not establish trading quality or profitability.

Scope: execute the two supplied early-detection specifications, with the later `GPT-6 Astra Extra High — IDX Scanner Early Detection Overhaul.md` governing the expanded requirements. Preserve the existing UI. Repository baseline: `7ed0b7d97e0f6401d065ac857834e4e7e67aeb2a` from `https://github.com/ryofficeics-pixel/IDX-scanner-1.0.git`.

No continuation automation was created: a quota exhaustion was not established. The explicit morning stop takes precedence over continued coding.

## Results that control the decision

Frozen real-provider validation data: 278 eligible symbol-days, 16,135 decision snapshots, 11 trading dates. There are only 22 runner-days reaching +8%, 11 reaching +12%, and one near-ARA proxy event. This is a small research sample, not sufficient evidence of sustainable performance.

| Validation metric | Original baseline | Revised V2 | Current revised V3 |
|---|---:|---:|---:|
| +5% runner recall | 23/37 (62.2%) | 23/37 (62.2%) | 21/37 (56.8%) |
| +8% runner recall | 13/22 (59.1%) | 11/22 (50.0%) | 11/22 (50.0%) |
| +12% runner recall | 4/11 (36.4%) | 3/11 (27.3%) | 3/11 (27.3%) |
| Near-ARA detection | 0/1 | 0/1 | 0/1 |
| Median first signal gain, +8% runners | +4.02% | +3.02% | +3.28% |
| Median lead to high, +8% runners | 245 min | 265 min | 255 min |
| Median remaining upside, +8% runners | 6.97% | 7.84% | 7.04% |
| Median captured move ratio, +8% runners | 64.0% | 74.1% | 73.3% |
| +8% runners detected before +3%, all runners denominator | 13.6% | 22.7% | 18.2% |
| +8% runners detected before +5%, all runners denominator | 54.5% | 40.9% | 40.9% |
| Candidate signal-days | 85 | 244 | 210 |
| Precision for +5% runner detection | 27.1% | 9.4% | 10.0% |
| False positive rate, nonrunner denominator | 22.8% | 87.6% | 74.7% |
| False discovery rate, signal denominator | 72.9% | 90.6% | 90.0% |
| Signals per trading day | 7.73 | 22.18 | 19.09 |
| Conservative expectancy after modeled costs | -1.014% | -1.263% | -1.118% |

V3 median MFE/MAE: +0.750% / -1.435%; baseline: +1.294% / -2.024%. V3 probability of +3% before -2%: 9.52%, baseline 18.82%. These candidate-level metrics are distinct from the separately reported actionable-BUY subset. All are simulated, not actual trades. Signal timing statistics condition on detected runners, so compare recall alongside timing; do not interpret an earlier median alone as improvement.

V3 runtime: baseline 64.805 seconds, revised 137.256 seconds on the same validation input. Runtime also needs work. The latest chronological test period remains **unevaluated**. Validation has been used for iterative decisions and is no longer an untouched holdout.

The initial corrected development trial also failed: +8% recall fell from 57/92 to 38/92 and median first gain worsened from +4.48% to +5.74%. An intermediate artifact under `test-results` was removed by Playwright's normal output cleanup. The current data and V2/V3 reports are protected under `.replay-cache/`, which is ignored by Git. Do not describe the lost initial capture as byte-identical to the recapture.

## Implemented changes

### Detection and risk

- Added separate daily setup, intraday trigger, confirmation, entry-efficiency, and market-regime engines. Daily compression, tightness, volume dry-up, high proximity, and date-aligned benchmark relative strength feed setup scoring.
- Added completed opening ranges, same-clock cumulative volume baselines, price/volume acceleration, VWAP transitions, failed-breakout and wick checks. Closed five-minute bars are required for timestamped histories.
- Separated daily setup from an intraday compression score and exposed lifecycle phases, explanations, scores, and risk components. This combination is still experimental and contributes to excessive candidate noise.
- Separated ARA setup/trigger from continuation and tightened the latest early-momentum path to require price and volume acceleration. Near-ARA detection is not validated by the one-event sample.
- Added structured liquidity, freshness, chase, volatility, market, and structural risks. Missing history does not create strong early signals. Daily/intraday future bars are excluded at the decision timestamp.
- Added BOW pattern alternatives: moving-average pullbacks, breakout retest, contraction, flow-supported pullback, and failed-breakdown recovery, with invalidation. Pattern-specific calibration and entry-plan consistency still need review.

### Discovery and data reliability

- Replaced gain-only history prioritization with a capped candidate union covering quiet setups, relative volume, liquidity, and previous candidate state. Added per-symbol, best-effort Redis/local state and bounded Redis calls.
- Fixed propagation of history-derived average volume into actual signal inputs.
- Fixed provider aliases and null-to-zero coercions; removed use of bid/offer values as fabricated broker flow; corrected IHSG historical-symbol routing.
- Added bounded scan provider calls and a 45-second outer budget. All required recommendation collections remain in API output.
- Evening scan can discover a quiet setup when the official summary endpoint is unavailable. Added test-only debug time support consistent with scan testing.

### Research and execution assumptions

- Rebuilt intraday replay around chronological completed five-minute bars. Original baseline modules load from the baseline Git revision, including original dependencies, rather than borrowing revised risk/indicator modules.
- Decisions use prior completed daily history, contemporaneous intraday snapshots, and historical benchmark context. Entry occurs at the next bar's open.
- Added configurable costs, liquidity-tier slippage, gap handling, and conservative/optimistic same-bar outcomes. Default modeled buy/sell fees: 0.15%/0.25%; slippage per side: 0.1%, 0.25%, or 0.5% by liquidity tier; target/stop: +3%/-2%. These are assumptions, not a promise of executable fills.
- Reports include +5/+8/+12/near-ARA recall, timing, remaining upside, capture ratio, MFE/MAE, false positives, expectancy, and score/phase/regime/price/liquidity segments. Chronological 60/20/20 development/validation/test boundaries replace shuffled evaluation.
- The legacy daily backtest now uses conservative execution handling. Legacy optimization scripts were not fully replaced and must not be used as evidence for this overhaul.

## Verification

- Earlier full unit/API suite: 54/54 passed before the final additional evening test.
- Latest targeted discovery/API suite: 3/3 passed, including quiet evening discovery without official summary data. A final combined suite was rerun at handoff; see final-check amendment below.
- JavaScript syntax check: 62 files passed before final handoff; rerun included in final checks.
- Gateway: 17/17 passed.
- Playwright browser suite: 9/9 passed using the installed Chromium executable override. Initial attempts failed because the newly installed Playwright expected a browser revision not present locally; this was an environment failure, not hidden as a pass.
- Stress checks: health 7,806 requests; three-symbol scan 2,270; 120-symbol scan 132; zero non-2xx responses. These mainly measure warm-cache behavior, not proven cold serverless latency.
- Official summary requests returned HTTP 403 during checks; fallback behavior was exercised. Full success from that upstream was not established.
- `git diff --check` passed. No UI source edits. Current and baseline `public/index.html` Git blob hash: `9f5739eae9daf1339168cd00d6b671a49e3b917f`. Frontend tests also verify unchanged UI/symbol assets.
- Original frontend tests had a CRLF-sensitive initialization split; fixed the test harness without editing the UI. One signal fixture was replaced with coherent accelerating bars so its strong-signal assertion tests real trigger evidence.

Anti-Slop DURING mode and Ponytail influenced the implementation: reused existing dependencies, kept backend modules plain CommonJS, and did not redesign the UI or introduce a framework. No applicable UI delivery changes were made.

## Remaining blockers and next work

1. **P0: Reduce false candidates without sacrificing runner recall.** Audit V3 signal rows by category, phase, and regime on development data. The V2/V3 timing gain is not enough to accept the revision. Do not promote these defaults to production.
2. **P0: Replay the actual bounded candidate-selection pipeline**, including discovery misses and optional state transitions. Current research enriches the sampled universe and does not prove production discovery coverage.
3. **P0: Preserve the untouched newest test period.** Freeze a defensible candidate before using it; repeated test-set tuning would invalidate it.
4. **P1: Complete BOW and morning-plan consistency review and pattern-specific fixtures.** Check verdict/action alignment and entry/invalidation plans. Broad BOW profitability and overnight morning effectiveness are not demonstrated.
5. **P1: Finish provider freshness and runtime hardening.** Some quote paths timestamp fetch time rather than verified exchange time. Outer timeouts do not necessarily abort underlying provider requests. Evening scan does not yet share the complete global scan deadline. Cold full-universe runtime remains unproven.
6. **P1: Replace or explicitly retire old optimization scripts.** They retain legacy research assumptions and are not a sound validation path. Replay speed is about twice baseline in this validation run.
7. **P1: Expand point-in-time data and regimes.** Current-universe survivorship bias, unavailable historical broker flow, corporate actions, short intraday coverage, incomplete-session exclusion, and five-minute execution ambiguity remain. Regular-board ARA is only a proxy; special boards/IPO exceptions and queue availability are not modeled. Reference: [IDX trading hours and mechanism](https://www.idx.id/en/products-services/trading-hours-and-mechanism/).

## Data and commands

Frozen capture: `.replay-cache/replay-data.json`; SHA-256 `3f8363a2a21bc38ad43e8fbee6d1def549a1d18b85af4b7030a9b314ba949c66`; captured 2026-09-07 23:55:59 UTC. Requested the first 20 repository symbols plus 20 evenly spaced members without ranking future returns; after overlap, 38 stocks and IHSG were acquired. TGRA failed. Yahoo five-minute history spans roughly June 17 through September 7, with daily context. Exact source bars and failures are retained in the capture.

Current machine reports:

- `.replay-cache/replay-validation-v2.json`
- `.replay-cache/replay-validation-v3.json`

PowerShell, from `G:\codex\IDX 1.0`:

```powershell
$idxNode = 'C:\Users\Ryan\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $idxNode scripts/check.js
& $idxNode --test tests/api.test.js tests/enrich.test.js tests/frontend.test.js tests/signal.test.js tests/earlyDetection.test.js tests/discoveryApi.test.js
& $idxNode scripts/intradayBacktest.js .replay-cache/replay-data.json development .replay-cache/replay-development-next.json
& $idxNode scripts/intradayBacktest.js .replay-cache/replay-data.json validation .replay-cache/replay-validation-next.json
# Run the test split only after freezing the final candidate.
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE = 'C:\Users\Ryan\AppData\Local\ms-playwright\chromium_headless_shell-1234\chrome-headless-shell-win64\chrome-headless-shell.exe'
$env:PLAYWRIGHT_HTML_OPEN = 'never'
$env:PATH = (Split-Path $idxNode) + ';' + $env:PATH
& $idxNode node_modules/@playwright/test/cli.js test
```

Do not store frozen replay data in `test-results`; Playwright cleans that directory. Do not recapture over the frozen dataset while comparing variants. No new third-party runtime dependency was added.

## Git handoff

Tracked diff at handoff: **17 files changed, 638 insertions, 458 deletions**. This excludes new untracked files and this report. No staging/commit was performed.

```text
 M .gitignore
 M api/eveningScan.js
 M api/scan.js
 M lib/cache/redisCache.js
 M lib/engine/bowEngine.js
 M lib/engine/indicators.js
 M lib/engine/riskEngine.js
 M lib/engine/signalEngine.js
 M lib/providers/idxApiProvider.js
 M lib/providers/idxProvider.js
 M lib/providers/yahooProvider.js
 M package.json
 M playwright.config.js
 M scripts/backtest2y.js
 M scripts/intradayBacktest.js
 M tests/frontend.test.js
 M tests/signal.test.js
?? lib/config/signalConfig.js
?? lib/engine/candidateDiscovery.js
?? lib/engine/confirmationEngine.js
?? lib/engine/entryEfficiency.js
?? lib/engine/regimeEngine.js
?? lib/engine/setupEngine.js
?? lib/engine/triggerEngine.js
?? lib/market/historyContext.js
?? lib/store/candidateState.js
?? scripts/captureReplayData.js
?? scripts/check.js
?? tests/discoveryApi.test.js
?? tests/earlyDetection.test.js
?? EARLY_DETECTION_HANDOFF_2026-09-08.md
```

All untracked implementation files are required alongside the tracked edits. A tracked-only patch is not a complete handoff.
