# IDX early-detection overhaul: implementation and evaluation

## Verdict

Keep this revision on the review branch. Do not promote its BUY classifier to production.

The implementation, chronological replay, regression checks, and final holdout evaluation are complete. The requested trading-quality outcome is not established. Candidate screening produces fewer false positives without losing test runner recall, but test detection is not broadly earlier and actionable BUY quality regresses. Passing software tests does not override that result.

Scope follows both supplied Markdown specifications, with the later expanded overhaul specification governing. No UI redesign, new trading execution, paid service, database requirement, or deployment command was introduced. Baseline: `7ed0b7d97e0f6401d065ac857834e4e7e67aeb2a`. Delivery branch: `codex/early-detection-overhaul`; `main` remains untouched. The earlier 07:10 WIB handoff is historical and superseded by this report.

## Results

These are first meaningful candidate signals, not all raw scores and not exclusively BUY orders. Precision means a signal preceding the high on a day reaching +5% from the prior close. It is not trade win rate. Each eligible symbol-day contributes at most one candidate event and one separately measured actionable event.

Values below are baseline / revised. Percentages are rounded; [the machine-readable evidence](reports/early-detection-2026-09-08.json) retains full precision, counts, configuration-source hashes, score bands, price/liquidity groups, regimes, and execution metrics.

| Candidate metric | Train | Validation | Untouched test |
|---|---:|---:|---:|
| Eligible symbol-days | 835 | 278 | 314 |
| Decision snapshots per engine | 47,816 | 16,134 | 17,885 |
| +5% recall | 57.5% / 66.0% | 62.2% / 62.2% | 72.9% / 72.9% |
| +8% recall | 62.9% / 70.0% | 59.1% / 59.1% | 82.1% / 82.1% |
| +8% detected / eligible runners | 44 / 70 vs 49 / 70 | 13 / 22 vs 13 / 22 | 23 / 28 vs 23 / 28 |
| +12% recall | 64.1% / 71.8% | 36.4% / 36.4% | 77.8% / 77.8% |
| Near-ARA detected / runners | 3 / 8 vs 3 / 8 | 0 / 1 vs 0 / 1 | 3 / 5 vs 4 / 5 |
| Median first gain, +8% runners | +4.61% / +5.28% | +4.02% / +3.28% | +4.39% / +4.39% |
| Detected before +3%, all +8% runners | 14.3% / 12.9% | 13.6% / 18.2% | 17.9% / 14.3% |
| Detected before +5%, all +8% runners | 37.1% / 34.3% | 54.5% / 54.5% | 42.9% / 46.4% |
| Median remaining upside, +8% runners | 7.31% / 6.80% | 6.97% / 7.04% | 7.98% / 7.98% |
| Median captured-move ratio, +8% runners | 60.0% / 60.0% | 64.0% / 70.0% | 68.0% / 67.7% |
| Median lead to high, +8% runners | 110 / 90 min | 245 / 250 min | 90 / 90 min |
| Candidate signal-days | 264 / 271 | 85 / 75 | 105 / 93 |
| Candidate precision | 33.3% / 37.3% | 27.1% / 30.7% | 33.3% / 37.6% |
| False-positive rate, nonrunner denominator | 22.3% / 21.1% | 22.8% / 17.0% | 23.7% / 18.0% |
| False-discovery rate, signal denominator | 66.7% / 62.7% | 72.9% / 69.3% | 66.7% / 62.4% |
| Signals per trading day | 7.76 / 7.97 | 7.73 / 6.82 | 8.75 / 7.75 |
| Median MFE | +1.21% / +1.30% | +1.29% / +1.41% | +1.17% / +1.35% |
| Median MAE | -1.87% / -1.88% | -2.02% / -2.02% | -1.46% / -1.63% |
| Conservative expectancy after modeled costs | -1.211% / -1.021% | -1.014% / -1.003% | -0.952% / -0.870% |

The +8% test recall target of at least 60% is met by both engines. The revised median-first-detection target of at most +4% is missed. Test +12% median detection improves from +5.48% to +4.91%, but median remaining upside falls from 11.80% to 10.82%. Near-ARA recall rises by one event while its median first gain worsens from +5.53% to +8.77%; five events cannot support a reliable ARA conclusion.

Timing medians condition on detected runners and can change because different runners are caught. Among the 21 test +8% runners both engines detected, the revised engine was earlier on 2, unchanged on 15, and later on 4. Mean first-gain difference was +0.373 percentage points; median difference was zero. The corresponding shared validation cohort also had zero median difference. Thus the aggregate validation median alone is not proof of a general timing improvement.

### Actionable BUY regression

| BUY-only metric | Train baseline / revised | Validation baseline / revised | Test baseline / revised |
|---|---:|---:|---:|
| Signal-days | 83 / 76 | 32 / 28 | 35 / 37 |
| Runner precision | 45.8% / 39.5% | 43.8% / 32.1% | 68.6% / 27.0% |
| Conservative expectancy | -1.146% / -0.516% | -0.719% / -0.114% | +0.345% / -0.352% |

On the test BUY subset, median MFE falls from +3.23% to +0.53%; median MAE improves from -1.41% to -0.80%. Probability of +3% before -2% falls from 42.9% to 16.2%. The revised trigger catches smaller moves with less excursion, but this does not compensate for costs. Earlier BUY labels also mechanically lose the precision advantage of buying stocks that have already become +5% runners; the negative execution result is the stronger rejection evidence. Neither the baseline's small positive test subset nor any revised score establishes sustainable profitability.

### Evening and BOW

Evening replay uses completed daily information at 17:00 WIB, then next-session opening entry. It purges split-boundary trades. The opening gap is descriptive, not an executable return from an already closed market.

Validation: 49 revised watch signals, 1 subsequent +5% runner, 2.04% precision, modeled expectancy -1.184%. Test: 58 watch signals, 3 runners, 5.17% precision, expectancy -0.847%. Both baseline and revised BOW_BUY subsets had zero events in this sample. New patterns require observed intraday recovery before becoming BOW_BUY; quiet overnight setups remain WATCH. This is functional discovery coverage, not evidence of an overnight edge.

## Confirmed causes and changes

- Existing enrichment favored current liquidity and absolute movers, restricting history available to quiet setups. `candidateDiscovery.js` now selects a bounded union of quiet pre-move names, relative volume, liquidity, and prior candidate state. Caps are per API request, not the whole exchange.
- Derived average volume was calculated but not consistently passed into the actual stock evaluated by the engine. `api/scan.js` now attaches it. Daily context excludes the forming day until the conservative 17:00 WIB cutoff.
- The prior scorer mixed trend magnitude, setup, and confirmation. Separate setup, trigger, confirmation, entry-efficiency, and regime functions now expose their measurements and lifecycle phases. Central configuration contains the evaluated thresholds and weights.
- Triggers calculate actual VWAP reclaim/bounce/rejection, completed 15/30-minute opening ranges, local breakouts/failures, price acceleration, and volume acceleration. Same-clock cumulative volume uses up to ten prior sessions and needs at least three matching opening/current-slot baselines. Cache invalidation is tested against changed historical volume.
- Live history now requests one month of five-minute bars so the same ten prior sessions can be available as in replay. Production and replay both exclude lunch-boundary and closing-auction bars. Full frozen-data preprocessing parity passed for 2,194 symbol-days, including IHSG.
- Risk separates market, liquidity, data, volatility, chase, and structure. Thin liquidity, unverified timestamps, failed breakouts, and unsupported spikes cannot be offset by a high weighted score. Fetch time is not treated as market freshness; completed candles can provide a verified snapshot. BOW now also blocks actionable output for missing, invalid, future, stale, or fetch-only timestamps.
- ARA setup/trigger metadata is separated from continuation. Compression alone no longer creates a visible early candidate. The legacy ARA potential component retains its session-curve volume basis; other confirmation features can use same-clock volume. These are different measures, not an undocumented substitution.
- BOW supports MA20/MA50 pullbacks, breakout retests, contraction pullbacks, flow-supported pullbacks, and failed-breakdown reclaims. Entries, invalidation, stops, and pre-market plans are consistent; unconfirmed patterns have no active pre-market plan.
- Provider aliases, null handling, and IHSG routing were corrected. Bid/offer quantities are no longer fabricated broker flow. Foreign-flow writes require a real trade date; cumulative reads exclude future/expired rows. Missing flow stays unknown.
- Provider work has a shared 45-second budget, bounded concurrency, partial-result handling, and bounded optional Redis operations. State saves are awaited within the request rather than abandoned after returning a serverless response. Redis remains optional.

The BUY failure is not a missing implementation module. The revised setup/trigger weighting and entry gates did not generalize into enough post-entry continuation. More architectural layers or more threshold searches on the consumed test set would not prove a fix.

## Methodology and tuning record

The old engine is loaded directly from the baseline Git commit and replayed against the same inputs and execution assumptions. No old optimistic optimizer output is used as the baseline here. Legacy optimizer entry points now stop with an explicit retirement error; the daily backtest remains a legacy research path, not the intraday proof.

Frozen dataset SHA-256: `3f8363a2a21bc38ad43e8fbee6d1def549a1d18b85af4b7030a9b314ba949c66`. Captured 8 September 2026 at 06:55:59 WIB from Yahoo chart: 38 stocks plus IHSG, with TGRA unavailable. Selection used the first 20 repository symbols plus 20 evenly spaced universe members, deduplicated, without ranking future returns. Raw data and detailed event reports remain in ignored `.replay-cache/`; only aggregate evidence is committed. A later download is not byte-identical because retention windows and provider revisions change.

Chronological folds: train 17 June to 3 August; validation 4 to 19 August; test 20 August to 7 September. This is one chronological train/validation/test experiment, not repeated rolling walk-forward validation. Validation was used iteratively and is not an untouched holdout. V10 classification settings were frozen before test outcomes were inspected. Subsequent fixes concern BOW freshness and production/replay input parity, not parameter fitting to test results.

Train and validation tables are full-history comparisons. The final test additionally replays the old top-20-liquidity/top-20-absolute-momentum history union versus revised capped discovery with chronological optional state. State starts cold at the split boundary. With only 38 stocks, the 72-stock cap is not a whole-exchange stress test; separate 90/120-symbol synthetic tests verify the cap and future-independent selection. No claim is made about final top-20 display truncation or full-universe provider misses.

At each decision time, only completed five-minute bars and prior completed daily data are visible. Future mutation and forming-candle tests verify invariance. A meaningful detection must precede the day's first high bar. Eligibility requires prior 20-day average traded value of at least IDR500 million and opening/late-session coverage. Captured-move ratio is `(futureHigh - signalPrice) / (dayHigh - priorClose)`, clamped to 0..1.

Entry is the next bar's open, with 0.15% buy fee, 0.25% sell fee, and per-side slippage of 0.10%, 0.25%, or 0.50% by liquidity bucket. Default target/stop is +3%/-2%; +5%/-3% is also reported. Gaps use opening prices; a bar touching both target and stop is stop-first conservatively and target-first optimistically. Expiry is not recorded as target attainment. Test candidate ambiguity was 2 baseline events versus 1 revised, with optimistic expectancy still negative (-0.857% / -0.816%). MFE/MAE are subsequent session excursions, not realized returns under this exit rule.

Development rejected noisy early versions. V3 train produced 567 candidate-days at 15.7% precision; a rigid relative-volume gate cut +8% recall to 48.6% and was rejected. Restoring continuation/local demand recovered 70% recall. An ATR-normalized base added 18 signals for one extra runner and was rejected. A hard ATR veto failed existing functional tests and was rejected without weakening those tests. The final compression-or-confirmation condition reduced noise while retaining 49/70 train +8% runners. Cached train-only reclassification was checked for exact report parity against raw replay; the final train metrics were rerun through the full engine.

## Runtime and software verification

| Check | Result |
|---|---|
| JavaScript syntax | 68 files passed |
| Unit/API/frontend-contract tests | 64 passed, 0 failed |
| Stockbit gateway tests | 17 passed, 0 failed |
| Browser E2E, Chromium | 9 passed, 0 failed |
| Frozen-data production/replay bar parity | 2,194 symbol-days passed |
| Fresh-process 120-symbol scan | HTTP 200, 120 valid quotes, 72 histories, 6.465 seconds |
| Fresh-process evening scan | HTTP 200, 60 histories from 120 symbols, 3.090 seconds |
| Git whitespace check | Passed |
| UI source identity | Both public files match baseline Git blobs |

Fresh-process checks use real providers locally, not deployed Vercel cold starts. The evening benchmark uses a clock override to enter the after-market route; it does not prove end-of-day data availability. Debug disables persistence. Official IDX summary returned HTTP 403; TradingView/Yahoo fallback still completed both scans. Warm-cache stress checks earlier in this run completed 9,568 health, 1,715 small-scan, and 68 120-symbol requests with zero non-2xx responses. Those throughput figures are predominantly cache performance.

Offline replay runtime increased: train 180.590 to 385.171 seconds; validation 48.108 to 101.880 seconds; pipeline test 106.805 to 297.436 seconds. Concurrent local workloads affect these timings. Pipeline replay computes discovery state as well as metrics, so it is not directly comparable to full-history replay or one live request. The added signal work is slower; the measured live handler still fits its configured budget.

`vercel.json` gives both scan functions 60 seconds, with provider work budgeted to 45 seconds. This uses Vercel's documented [function duration configuration](https://vercel.com/docs/functions/configuring-functions/duration). No deployment runtime was verified. Outer timeout races do not cancel every nested operation, though provider fetches have individual timeouts. Exhaustion skips new provider work and returns partial data.

Existing test semantics were preserved. The frontend source-extraction test was made CRLF-compatible for Windows; signal tests gained entry-plan consistency assertions. The new BOW recovery fixture now supplies an explicit decision timestamp rather than assuming an undated quote is fresh. No failing strategy test was deleted to improve reported pass counts.

## Files and compatibility

Backend changes cover `api/scan.js`, `api/eveningScan.js`, `lib/config/signalConfig.js`, the setup/trigger/confirmation/entry-efficiency/regime/candidate modules, existing signal/BOW/risk/indicator modules, history/session handling, five provider files, Redis cache, candidate state, foreign-flow storage, and timeout utilities.

Research changes cover capture, chronological replay, morning replay, train auditing/reclassification, runtime benchmarking, evidence summarization, syntax checking, retirement guards for three legacy optimizers, and the daily execution helper. Tests cover API discovery, early detection, existing signal contracts, frontend extraction, and optional Chromium configuration. README, Git ignore rules, Vercel duration configuration, this report, historical handoff, and aggregate evidence complete the delivery. No runtime dependency was added.

At the evaluation commit, `public/index.html` matched the baseline blob `9f5739eae9daf1339168cd00d6b671a49e3b917f`. A subsequent user-authorized presentation-only commit changed its browser title and visible scanner badge from v2.0 to v2.2; the regression test rejects any other UI drift. `public/idx-symbols.js` remains unchanged. Recommendation collection keys remain compatible. New backend metadata is optional. Anti-Slop DURING and Ponytail constrained changes to the existing stack; Anti-Slop comment/copy guidance was used for touched explanations and this report. There was no UI redesign.

## Remaining limits and next decision

- Do not merge the revised BUY classifier on the strength of aggregate candidate precision. The actionable test regression controls the promotion decision.
- Capture genuinely new forward observations before further tuning. Compare a simpler candidate-only overlay with preserved entry gates against V10; do not call another run on this same test period untouched.
- Historical flow, sector context, corporate-action calendars, delisted constituents, orderbook queues, spread history, and executable ARA fills are unavailable in this dataset. The ARA calculation is a regular-board proxy, not a verified exchange fill opportunity. Holiday state is inferred from timestamps/data freshness rather than a complete holiday calendar.
- Opening/current-slot and end-of-day coverage do not prove every intermediate bar is present. Undated legacy fixtures remain supported internally; actual providers supply timestamps. Five-minute sampling misses within-bar sequence and does not establish tick-level detection speed.
- Setup state is best effort and optional. Foreign-flow array updates can race across serverless instances; Redis availability and concurrency are not proof of complete historical flow. Top-level provider timestamps may describe fetch time; actionable engine freshness uses the stricter checks described above.
- Score segmentation uses fixed ten-point bands, not equal-population quantiles. Baseline regime labels are unavailable. Revised test bullish-regime candidate precision was 16% versus 45.6% in neutral conditions, with no bearish test sample. Do not infer regime robustness.

The highest-value next work is forward validation of entry quality, not more UI, dependencies, or in-sample threshold searches. The research result is a failed production-promotion gate with useful reliability fixes and a reproducible evaluation path.

## Reproduce

Run the commands in README for software checks. To regenerate this aggregate report from retained local artifacts, run `node scripts/summarizeReplay.js`. Raw replay requires the frozen local dataset and the baseline Git commit; aggregate metrics alone cannot recreate provider candles. Keep `.replay-cache/` outside disposable browser-test outputs.

Inspect the delivered change with `git diff --stat 7ed0b7d97e0f6401d065ac857834e4e7e67aeb2a HEAD` and repository cleanliness with `git status --short`. Publication and final status are verified in the task handoff after commit/push; this document does not assert a deployment or profitable outcome.
