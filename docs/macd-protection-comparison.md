# MACD profit-protection comparison

This is an observational comparison, not a change to trading settings.

## Run

After deployment, open `GET /api/strategy/comparison`, or run:

```sh
node scripts/compare-macd-protection.cjs https://pumpfun-production-7acb.up.railway.app
```

An offline JSON array from `LearningStore.getCompletedWindows()` can be passed
instead of the URL. Keep large raw exports out of Git.

## Four variants

1. **baseline**: current prior-closed 5m MACD policy, 50 shares every ten seconds
   from seconds 10–290, existing gates, fees, TP/SL and expiry conventions.
2. **fourBar**: pause same-direction entries if all four latest consecutive
   closed bars are SOLID_GREEN (UP) or SOLID_RED (DOWN). Shrinking bars are not
   strengthening bars. Reversal follows the normal prior-candle mapping, not a
   forced reversal merely because the count reached four.
3. **trailing**: protect the aggregate position when visible-depth net
   liquidation profit reaches an activation threshold per share. Track the
   highest fresh own-side bid after activation; a retracement triggers a
   full-position visible-bid sweep and stops later buys in that window.
4. **combined**: both changes.

Trailing candidates are activation `$0.05/$0.10/$0.15` and retracement
`$0.03/$0.05/$0.08`. These are experimental values, not enabled defaults.
Only the first chronological 70% selects trailing parameters; the later 30%
is held out. At least 20 training and 10 holdout windows are required.
The API caches results for five minutes and runs computation in a separate
worker so replay does not block the trading loop. At most 120 completed
windows are loaded.

## Interpret honestly

- All variants use the same eligible windows. Exclusions are reported.
- Old strategy versions, missing contiguous histogram history, incomplete
  near-close quote coverage and unresolved baseline positions are excluded.
- No signal can use a candle observed after the decision. New samples retain
  actual observation times and four closed histogram bars once per window.
- Legacy sample times were rounded down to 500ms; replay conservatively uses
  that bucket's upper bound. Historical slot eligibility is approximate.
- There is no interpolated quote fill or catch-up entry. Missing snapshots
  can miss scheduled entries; the result is a replay of recorded observations,
  not proof that all historical live ticks were captured.
- A trailing sell needs enough recorded bid depth for the entire position;
  otherwise the exit is deferred. Fees use each consumed price level.
- Database reads retain at most 20 recorded levels per side before transferring
  data to Node, avoiding unbounded historical-book memory use. If these levels
  lack enough depth, replay skips/defer fills rather than assuming more liquidity.
- Original TP/SL and expiry retain paper payout/mark conventions. They are
  not guaranteed executable exchange orders.
- Each window starts with $10,000 paper cash; this standardizes comparisons
  but does not model capital carried continuously between windows.
- Reported drawdown is between closed windows. Peak giveback uses bid marks,
  not a guaranteed liquidation value. Trailing can still lose money, especially
  after slippage, gaps, fees, or additional entries after activation.
- Do not deploy a winner automatically. Review holdout net P&L, drawdown,
  giveback, skipped windows and sample coverage. Reusing the holdout to retune
  requires a new untouched validation period.

No strategy settings, live orders, paper positions, ledger balances or stored
tuning settings are modified by the comparison endpoint itself. Deploying new
server code still restarts the existing in-memory paper ledger.
