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
500 shares. Any loss also resets the next size to 500 shares. If an eligible
signal produces no fill because both entry filters reject it, a signal-side win
still reduces shares and a signal-side loss resets them. An unresolved or
ineligible window does not change the size. A no-fill result never creates a
position or changes capital.

Because this is a binary market, a winning position pays `$1.00` per share and
a losing position pays `$0.00` per share. The `$0.35` entry cost is deducted
from the paper balance. While a position is open, portfolio
equity is marked to the latest live bid: cash balance plus position market
value. Realized P&L comes from settled positions, while unrealized P&L is the
live mark-to-market result.

## Entry execution

For an eligible signal, the bot:

1. places one resting limit buy at `$0.35` immediately after the window starts;
2. keeps the full order resting until the five-minute window closes;
3. leaves the order unfilled if the full requested size never becomes available
   at `$0.35`.

There is no taker fallback, no ladder, no second limit order, and no Binance
dependency.

## Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Dashboard: `http://localhost:8000`

## Configuration

- `BASE_SHARES` — starting and reset size, default `500`.
- `WIN_STEP_SHARES` — reduction after a win, default `100`.
- `LIMIT_ENTRY_PRICE` — resting entry price for the full window, default `0.35`.
- `WINNER_THRESHOLD` — final-second CLOB winner threshold, default `0.95`.
- `FINAL_SECOND_SECONDS` — final-second observation window, default `1`.
- `MAKER_REBATE_RATE` — expected Crypto maker-rebate share, default `0.20`.

## Fees, rebates, and logs

Makers pay no trading fee. For the Crypto market schedule, the paper model uses
Polymarket's documented fee-equivalent formula:

```text
fee_equivalent = shares × 0.07 × price × (1 - price)
maker_rebate = fee_equivalent × 0.20
```

At `$0.35`, a 500-share maker fill accrues an estimated `$1.5925` rebate. The
real Polymarket rebate is paid daily from a market-wide pool and may require a
minimum accrued payout, so the bot labels this as an accrued estimate rather
than a guaranteed per-fill payment.

Every bot event is written as structured JSON to `logs/bot-events.jsonl` and
also emitted to stdout for Railway logs. The tracker keeps a rotated backup and
can be queried while the bot is running:

```text
GET /api/logs
GET /api/logs?event=ENTRY_FILLED&limit=200
GET /api/logs/summary
```

Relevant official references:

- https://docs.polymarket.com/trading/fees
- https://docs.polymarket.com/programs/maker-rebates
- https://docs.polymarket.com/market-data/market-details#trading-fees

The app remains paper trading by default. Review the behavior and paper
results before connecting any live execution system.