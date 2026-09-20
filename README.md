# ⚡ ALPHASTRIKE — BTC 5m up/down bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Strategy:
**the current window decides the next window.**

## The signal (`app/strategy.py`)

From the five 1-minute BTC closes `c1..c5` of the window that just closed:

- **UP** — minute 2 closed *below* minute 1 (early dip) **and**
  `avg(c3, c4, c5) > avg(c1, c2)` (then recovered).
- **DOWN** — exactly the opposite: minute 2 *above* minute 1 **and**
  `avg(c3, c4, c5) < avg(c1, c2)`.
- Anything else (including any tie) → no pattern → **no trade** next window.

Averages are compared rather than raw sums, because three prices always
add up to more than two; the mean makes "minutes 3–5 vs minutes 1–2" a
fair comparison. Minute prices are Binance BTCUSDT 1-minute closes
(public REST, no key); the bot reads the previous window's five candles
the moment the new window opens (retrying each second until the last
minute has finished closing, giving up after 60s).

## The trade (`app/engine.py`), in the NEXT window, on the signalled side

One order type: a **taker market buy**.

1. **2 seconds after the window opens**, buy **300 shares at market** on
   the signalled side, **whatever the price** — no price cap, no resting
   limit order, no timeout. The fill is priced by walking real ask depth
   and the taker fee is included in cost basis. If the signal is only
   known after the 2s mark, the buy fires the moment it is known. If that
   side has no ask / no depth, it retries every tick until the window
   closes (nothing is ever invented).
2. One entry per window.
3. No stop-loss. Take profit at **0.99** (taker sell, depth-walked);
   otherwise force-closed (taker) at window end.

A bot that starts mid-window skips that window and trades from the next.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # all vars optional
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000: **the current window's live BTC
minute 1–5 prices** (closed minutes show their final close, the minute in
progress updates every second, later minutes show "not started"), the
previous window's five closes with the two tests ✓/✗, the armed entry /
open position, a history of recent windows (signal, winner, what happened,
P&L, running signal accuracy), stats, equity curve and event log. If your
host is geo-blocked from `api.binance.com`, set `BINANCE_KLINES_URL` to a
mirror such as `https://api.binance.us/api/v3/klines`.

## Layout

- `app/strategy.py` — the signal (pure functions), candle selection, and
  the live min1–min5 view used by the dashboard
- `app/binance.py` — Binance 1-minute klines
- `app/engine.py` — taker entry at +2s → TP / forced close
- `app/state.py` — runtime loop, previous-window candle fetch, live-minutes
  task (separate, so it can never delay the entry), window rolling
- `app/polymarket_client.py`, `app/paper_broker.py`, `app/models.py` —
  Polymarket CLOB access, fee/log helper, shared types
- `tests/` — `python tests/run_all.py` (no network needed): the signal
  rule and its edge cases, the entry/exit flow (timing, any-price buy,
  empty book, TP, forced close) and the orchestration with a fake Binance
  and fake Polymarket

## Config (`app/config.py`, env-overridable)

`ENTRY_DELAY_SECONDS` (2), `TAKER_SHARES` (300), `TP_PRICE` (0.99),
`STARTING_CAPITAL` ($2000), `POLL_INTERVAL_SECONDS` (1.0),
`LIVE_MINUTES_POLL_SECONDS` (1.0).

## Notes / assumptions

- "Minute N price" = the close of the Nth 1-minute candle (for the minute
  still in progress on the dashboard: the latest price).
- The entry can only fire on a poll tick, so it lands between 2.0s and
  ~3s after open at the default 1s poll interval; lower
  `POLL_INTERVAL_SECONDS` to tighten it.
- Buying "regardless of price" means the bot pays whatever the ask is,
  including 0.95+. An entry at/above the 0.99 TP level will take profit
  on the next tick (and the sell fee can make that a small loss).
- Outcomes (signal right/wrong, win/loss) come from the last observed
  Polymarket CLOB midpoint at window rollover (`state.py`'s
  `_infer_winner`), not Polymarket's own settled resolution. Polymarket
  settles on the Chainlink BTC/USD stream; the signal uses Binance
  prices, which track it closely but not identically.
- Taker fee uses `TAKER_FEE_RATE`/`TAKER_FEE_EXPONENT` in `config.py`;
  verify against Polymarket's fee-rate endpoint before real money.
- This is a fixed rule, not a fitted model: nothing here has been
  backtested. Whether the pattern has an edge is an open question — the
  dashboard's signal-accuracy tally is there to measure it as it runs.
