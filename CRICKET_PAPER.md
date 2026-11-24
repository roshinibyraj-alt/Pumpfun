# Cricket radio paper-trading console

The Pumpfun paper Railway service now runs `node artifacts/api-server/cricket/server.cjs`.
The former automated BTC strategy is not imported or started. Other GitHub branches
and the separate real-money bot are unaffected.

## Use

Open the dashboard, paste an official Polymarket cricket event or sports URL and
load it. All supported CTF order-book submarkets and their outcome IDs load together.
Multiple matches remain available; old holdings are retained until sold or officially
resolved. New cricket paper capital starts at $3,000, separate from the old BTC ledger.

Listen to your own radio. Tap BUY 100 on the relevant team, then SELL ALL when you
choose to exit. There is no radio integration, automated signal, automatic early exit,
wallet connection, signer or real order submission. The dashboard is public and
its paper account is shared across visitors.

## Simulation

- The matching delay comes from each market's `secondsDelay` and applies to buys
  and sells. Missing delay/fee metadata blocks trading.
- At eligibility use a fresh, post-delay book snapshot, with WebSocket updates
  and REST book refreshes. Never fill at a cached tap-time price.
- Default adverse price allowance is 3 cents per share, adjustable from 0–20 cents.
  This is a cap relative to the tapped ask/bid, not a guaranteed fill.
- Sweep asks for buys and bids for sells. Respect available size, market minimum
  shares, tick size and the price cap; unfilled remainder is cancelled (FAK model).
- Apply the market's published fee schedule to both buys and sells. Model fee in USD
  as quantity × rate × [price × (1 − price)]^exponent; no rebates are assumed.
  Exact exchange rounding/fee collection and competing traders cannot be reproduced.
- A partial sale removes proportional all-in cost basis. Equity is cash plus net
  proceeds available from current visible bids; depth that cannot be sold is valued
  at zero. Stale books are visibly marked, and block new orders.
- Remaining holdings receive official payout only after Gamma reports the market
  closed and UMA resolution status `resolved`, with validated outcome payouts.
  No payout is inferred from a price touching 99 cents.
- PostgreSQL saves to a separate `cricket_manual_paper_state` table. A local file is
  used only without DATABASE_URL. Restart restores holdings/history but marks
  in-flight paper requests INTERRUPTED, rather than replaying them.

Public displayed depth is not a guarantee that real orders would fill. The simulation
does not reproduce queue priority, every external cancellation race or chain settlement.
Compare radio timing to executable bids/asks, not only the displayed headline odds.

## Verification

`node --test artifacts/api-server/cricket/*.test.cjs`

Railway's build runs these checks before using the new standalone entry point.
No legacy paper reset/migration script runs for this service.
