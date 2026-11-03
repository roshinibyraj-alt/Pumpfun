# MACD protection replay — 3 November 2026

Generated at **2026-11-03 06:30:38 UTC** from the deployed read-only comparison
endpoint. No experimental rule was applied to the running paper strategy.

## Coverage

- Latest 120 completed stored windows inspected.
- 45 usable windows: 31 chronological training, 14 later holdout windows.
- Excluded: 70 incompatible strategy windows, 3 missing contiguous histogram
  history, 1 incomplete near-close quote record, and 1 unresolved baseline window.
- Earliest usable window: 02:30 UTC; holdout starts 05:10 UTC; latest usable
  window starts 06:15 UTC, all on 3 November 2026.
- Windows missing from the source history are not invented or interpolated.

## Holdout results

| Variant | Net paper P&L | Entries | Windows traded | Peak profit given back, summed | Maximum closed-window drawdown |
|---|---:|---:|---:|---:|---:|
| Current rules | $1,018.77 | 259 | 14 | $1,929.55 | $874.79 |
| Four-bar filter | $1,179.01 | 182 | 9 | $1,286.66 | $767.99 |
| Trailing only | -$28.94 | 168 | 14 | $1,246.87 | $637.36 |
| Four-bar + trailing | $567.61 | 112 | 9 | $565.93 | $137.04 |

The four-bar filter skipped five holdout windows. It waits after four
consecutive strengthening green bars before further UP entries, or four
strengthening red bars before further DOWN entries. It does not force the
opposite side solely because the streak count reaches four.

For both trailing variants, training selected $0.10 net liquidation profit
per share for activation and a $0.05 retreat from the highest fresh own-side
bid for the exit trigger. These values were not chosen using holdout results.
Trailing stops further entries after a protective trigger.

## Training results

| Variant | Net paper P&L | Entries | Filtered windows |
|---|---:|---:|---:|
| Current rules | $2,527.65 | 636 | 0 |
| Four-bar filter | $2,849.03 | 592 | 3 |
| Trailing only | $280.20 | 404 | 0 |
| Four-bar + trailing | $601.58 | 360 | 3 |

## Interpretation

The four-bar filter had the highest holdout profit in this sample. The
combined variant reduced measured giveback and closed-window drawdown much
more, but also cut profit. Trailing alone did not improve profit and should
not be enabled on the basis of these results.

**Recommendation:** forward-test the fixed four-bar filter beside the
unchanged paper strategy before enabling it. The holdout contains only
14 windows from one short period. It is evidence for another test, not
proof of a persistent edge or a guarantee of future profit. Do not reuse
this holdout to retune thresholds and still call it untouched validation.

## Important limits

Each replay window starts with $10,000 paper cash. These totals are not a
continuous funded-account return or actual realized trading profit. Fees and
the original paper TP/SL/expiry conventions are included, but those expiry
marks are not guaranteed exchange sales. Bid-mark peak giveback is not
guaranteed liquidation profit; drawdown is between window closes, not full
intrawindow drawdown.

Historical books were projected to at most 20 recorded levels per outcome
side before transfer to Node to bound memory use. Insufficient retained
liquidity skips/defer fills rather than assuming extra depth. Old logs have
500ms timestamp rounding; replay uses each bucket's upper bound. See
[comparison methodology](macd-protection-comparison.md) for the full assumptions.

The initial historical read exceeded the server heap; bounded database-side
projection and a 15-window limit for routine observational regression fixed
that issue. The final deployment was verified healthy, with learning storage
connected and the original 50-share schedule still running.
