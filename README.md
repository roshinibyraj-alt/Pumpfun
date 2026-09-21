# BTC 5-minute binary continuation bot

Paper-trading bot for Polymarket `btc-updown-5m-*` markets. This version uses
only the CLOB and 5-minute market windows. It does not use Binance prices,
technical indicators, AI, ladders, or a separate signal model.

## Strategy

The winner of the immediately previous window is the signal for the next
window:

- previous winner `UP` → buy `UP`;
- previous winner `DOWN` → buy `DOWN`.

The previous winner is confirmed from CLOB prices in the final second of the
closed window. A side is a winner when its CLOB price is at least `0.95`. If
neither side reaches `0.95`, the window is unresolved and the next window has
no signal.

The first window after startup is skipped because there is no previous result.

## Share progression

The first eligible trade uses 500 shares. After each winning trade, the next
trade size is reduced by 100 shares:

```text
500 → 400 → 300 → 200 → 100 → 0
```

Zero is the floor. If the next signal is the same side while the size is zero,
the bot skips. When the signal flips to the opposite side, the size resets to
500 shares. Any loss also resets the next size to 500 shares. A skipped or
unresolved window does not change the size.

Because this is a binary market, a winning position pays `$1.00` per share and
a losing position pays `$0.00` per share. Entry cost and any configured taker
fee are deducted from the paper balance.

## Entry execution

For an eligible signal, the bot:

1. places one resting limit buy at `$0.40` immediately after the window starts;
2. waits up to 30 seconds for the full order to fill;
3. cancels the resting order after 30 seconds if it is not filled;
4. from that point until the window closes, buys as a taker only when the
   complete depth-walked fill is below `$0.60`.

There is no ladder, no second limit order, and no Binance dependency.

## Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Dashboard: `http://localhost:8000`

## Configuration

- `BASE_SHARES` — starting and reset size, default `500`.
- `WIN_STEP_SHARES` — reduction after a win, default `100`.
- `LIMIT_ENTRY_PRICE` — resting entry price, default `0.40`.
- `LIMIT_TIMEOUT_SECONDS` — resting-order timeout, default `30`.
- `TAKER_MAX_PRICE` — maximum complete fill price after timeout, default `0.60`.
- `WINNER_THRESHOLD` — final-second CLOB winner threshold, default `0.95`.
- `FINAL_SECOND_SECONDS` — final-second observation window, default `1`.
- `APPLY_TAKER_FEES` — whether to simulate taker fees, default `true`.

The app remains paper trading by default. Review the behavior and paper
results before connecting any live execution system.