# BTC 5-minute binary continuation bot

Paper-trading bot for Polymarket btc-updown-5m-* markets. The previous window's confirmed winner is the signal for the next window.

## Strategy and execution

- The bot starts with **$5,000** of demo capital.
- Each eligible signal uses a fixed **$500 USDC notional** order. Shares are derived from the actual execution price; they are not the sizing input.
- At window start, place one maker limit buy at **$0.40** on the signalled side.
- If it has not filled after **30 seconds from window start**, cancel it.
- After cancellation, buy as a taker only while the signalled side's best ask is **strictly below $0.60**. If the ask is $0.60 or higher, keep polling until it returns below $0.60. The paper model will not cross the $0.60 cap for slippage.
- A full $500 notional must be available in the book; the paper model avoids partial fills.

A winning binary position pays $1.00 per share and a losing position pays $0.00 per share. Taker fees are added to the $500 notional cost. Maker rebates are tracked separately as an accrued estimate.

## Fee and rebate accounting

Polymarket's current Crypto formula is:

    fee = shares × 0.07 × price × (1 - price)

Makers pay no trading fee. The estimated Crypto maker rebate is 20% of the fee-equivalent amount:

    maker_rebate = shares × 0.07 × price × (1 - price) × 0.20

Fees are rounded to five decimal places. Actual maker rebates are distributed daily from the market-wide pool and are not guaranteed as an immediate per-fill cash payment; the paper model labels them as accrued estimates.

Examples:

- Maker at $0.40: $500 / $0.40 = 1,250 shares, $0 fee, estimated $4.20 rebate.
- Taker at $0.55: $500 / $0.55 = 909.090909 shares, $15.75 fee, $515.75 total cash cost.

## Run locally

    pip install -r requirements.txt
    uvicorn app.main:app --reload

Dashboard: http://localhost:8000

## Configuration

- STARTING_CAPITAL — demo balance, default 5000.
- ORDER_USD — fixed notional per eligible order, default 500.
- LIMIT_ENTRY_PRICE — maker limit price, default 0.40.
- LIMIT_ORDER_TIMEOUT_SECONDS — timeout from window start, default 30.
- TAKER_ENTRY_MAX_PRICE — taker trigger/cap, default 0.60 (strictly below).
- TAKER_FEE_RATE — Crypto fee curve rate, default 0.07.
- MAKER_REBATE_RATE — estimated Crypto rebate share, default 0.20.

Every bot event is written as structured JSON to logs/bot-events.jsonl and emitted to stdout. The app remains paper trading by default.

Official references:

- https://docs.polymarket.com/trading/fees
- https://docs.polymarket.com/programs/maker-rebates
- https://docs.polymarket.com/market-data/market-details#trading-fees
