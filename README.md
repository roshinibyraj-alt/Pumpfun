# BTC 5m Two-Engine Bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets, built on the
market-discovery/CLOB scaffolding of the reference ladder bot. Runs two
independent trading strategies on the same market/ticks, sharing a single
demo-capital balance.

## Strategy

### Engine 1 — resting ladder @ 0.29
1. **Enter**: on the first tick of each window, unconditionally place a
   resting maker BUY limit order on **both** UP and DOWN at 0.29. No wait,
   no price-band filter.
2. **Race**: whichever side fills first, the resting order on the
   opposite side is immediately cancelled.
3. **Exit**: the fill gets a resting maker TP sell at 0.99. No stop loss —
   if TP never hits, the position rides to window resolution ($1/share if
   its side won, $0 if it lost).
4. **Martingale**: base size $10. A loss doubles the size for the next
   window (2x → $20, 4x → $40, 8x → $80 — up to 3 doublings). A win, or
   completing the 3rd martingale level, resets size back to base.

### Engine 2 — breakout taker entry @ 0.70
1. **Enter**: watches both sides' mid-price every tick. Whichever side's
   mid-price reaches 0.70 first triggers a one-time taker market BUY of
   that side for $30 notional (crosses the spread, pays the taker fee).
   Fires at most once per window.
2. **Take profit**: resting maker TP sell at 0.99.
3. **Stop loss**: at 0.29 — the moment the bid drops to/through this
   level, immediately taker-sell (market order, pays taker fee) to
   guarantee the exit.
4. **Forced close**: if the window closes with the position still open
   (no TP, no SL hit), force a taker close (market sell) right at window
   end.
5. **Martingale**: base size $30. A loss (SL hit, or a forced close that
   lost money) doubles the size for the next window (2x → $60, 4x → $120,
   8x → $240 — up to 3 doublings). A win, or completing the 3rd
   martingale level, resets size back to base.

### Shared capital
Both engines draw from and pay into the **same** balance
(`STARTING_CAPITAL`) — there is one pot of capital, not two. The engine
halts permanently (both engines stop trading) if the shared balance ever
drops below $0. The dashboard's equity curve reflects this single shared
balance over time.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `ENGINE1_ENTRY_PRICE`, `ENGINE1_TP_PRICE`, `ENGINE1_BASE_USD`, `ENGINE1_MAX_MARTINGALE_LEVEL`
- `ENGINE2_TRIGGER_PRICE`, `ENGINE2_TP_PRICE`, `ENGINE2_SL_PRICE`, `ENGINE2_BASE_USD`, `ENGINE2_MAX_MARTINGALE_LEVEL`
- `STARTING_CAPITAL`, fee/rebate constants

## Notes / assumptions

- Engine 2's breakout trigger reads CLOB best bid/ask **mid-price**, checked every tick.
- Engine 1 is maker-only on both entry and exit (never crosses the spread), so it earns the maker rebate and never pays the taker fee itself.
- Engine 2's entry, its stop loss, and any forced window-end close are all taker orders and pay the taker fee for real; its TP is still a resting maker order.
- A forced close at window end counts as a win for martingale purposes if its realized P&L is ≥ $0, and a loss otherwise — there's no explicit TP/SL trigger to key off of in that case.
- This engine replaces the prior ladder-martingale engine entirely; it reuses `polymarket_client.py`, `models.py`, `paper_broker.py`, and the `main.py`/`state.py` orchestration loop unchanged in behavior.
