# Independent BTC rebound shadow experiment

Runs alongside Pumpfun's existing strategy, not as a replacement. It has its own
$3,000 ledger, flat 50-share requests, positions, fees, model, and training records.
The main bot's capital, sizing, strategy ID, and ledger are never changed.
Dashboard: `/shadow`; read-only state: `/api/shadow/state`.

## Model and attribution

Inspired by `philippotiger/btc-5min-polymarket-predictor` on Hugging Face,
whose README declares MIT licensing. No third-party pretrained weights are
downloaded or unpickled. This implementation trains its own LightGBM classifier
using a pinned public sample and subsequently collected live examples.

Target: after the first observed midpoint <= $0.35 on a side, will that midpoint
reach >= $0.75 before expiry? This is NOT P(UP) or the probability of winning
official settlement. A token can rebound successfully and still settle at zero.

The source sample's raw bid/ask level columns were often crossed, inconsistent
with its midpoint/spread. We intentionally exclude those book features, tape
features, author-supplied future labels, and claimed profit metrics. Instead we
reconstruct causal token-price momentum, streak, timing, spread, and absolute
BTC movement. Live entries/exits still require validated actual order books.
No invented pressure features or missing-field zero substitutions.

The public sample is small and old. All models remain explicitly EXPERIMENTAL,
including when test Brier beats baseline. Chronological whole-window splits
reserve separate training, sigmoid-calibration and untouched test sets, with
one window excluded at each boundary. There is no threshold optimization on
test data and no test-set early stopping. No claim of profitable execution.
The public sample stops roughly eight seconds before expiry: bootstrap labels
measure rebounds within that recorded horizon, not the unobserved final seconds.
Only sample windows reaching within ten seconds of expiry are included. This is
a disclosed censored proxy, never a claim of full-window ground truth; live
examples use the stricter observed-through-expiry rule below.
Retrain every six hours. Missing/failed/stale models do not receive fake scores.
If calibration makes the entry threshold mathematically unreachable, the
dashboard explicitly reports OBSERVING LOW CONFIDENCE, continues collecting
examples, and waits for retraining rather than implying that trades are ready.

## Trading and labels

Observe each side independently, from its window open (within five seconds),
or restore its own saved ongoing observations after a restart. A late-started
window is not eligible for a first-dip prediction. Score once at the first dip.
Only scores >= 0.63 can enter; require at least 300ms execution delay, current
quotes <=2s old, a still-cheap midpoint, and a score <=2s old. Unavailable
liquidity cancels unfilled quantity; there is no later stale-score fill.

Buy against visible asks with market-specific taker fees, and never buy a
level whose net $0.75 target proceeds cannot exceed its entry/exit fees.
At TP, sell only available bids >=$0.75, including exit fees. Partial sales
leave the rest open. Consumed depth is tracked across identical snapshots;
only observed replenishment becomes reusable liquidity. There is no $1 TP
credit, no stop-loss, no recovery sizing, no rearm, and no signal selling.
Anything unsold goes to official resolution, paying $1 or $0 with no sale fee.
Unknown/stale marks produce unknown equity, never zero-valued positions.

Future labels are generated separately from trade P&L. A positive needs an
observed rebound; a negative needs observed coverage through expiry without
gaps over five seconds. Incomplete observations do not become negatives.
Both sides of the same window always stay within the same training fold.

## Persistence and resource limits

Separate `rebound-shadow/ledger.json`, `training.json`, `model.json`, and the
downloaded sample live next to (not inside) the main paper ledger. Atomic saves
and full-ledger cash reconciliation prevent silent reset or duplicated funding.
Model process uses one thread; shadow errors do not interrupt the main bot.
No private keys, authenticated exchange endpoints, or real orders are used.
