# BTC 5-minute live continuation bot

This bot follows the previous BTC 5-minute window's confirmed winner and can place one live Polymarket FOK market BUY per eligible window.

## Live execution

- Set TRADING_MODE=live and provide POLYMARKET_PRIVATE_KEY through Replit or Railway Secrets. The key is read only by the authenticated Node bridge and is never returned to the dashboard.
- The dollar ladder is $5 -> $4 -> $3 -> $2 -> $1 -> $0 after wins. A loss or direction flip resets the next amount to $5; at $0, same-side signals are skipped until a direction flip.
- During the first 30 seconds after window open, the bot fires when the signalled token's best ask is strictly below $0.40.
- At 30 seconds and after, it fires when the best ask is strictly below $0.50.
- The order is a FOK market BUY. It must fill completely immediately or Polymarket cancels it. The bridge sends the highest valid price tick below $1.00, effectively removing price protection while respecting the CLOB tick size.
- There is no absolute fill guarantee: a FOK order still fails if there is not enough resting liquidity. A failed FOK is recorded and is not retried in that window.
- Polymarket handles trading fees and settlement. The live path applies no local fee or maker-rebate calculation.
- The dashboard Pause button prevents new live orders. FOK orders do not rest on the book, so there is no live order to cancel after submission.

## Why FOK instead of FAK

FAK can partially fill and cancel the remainder. FOK is the correct order type when the complete $5/$4/$3/$2/$1 amount must either fill immediately or not trade at all. No order type can guarantee a match when the order book has insufficient liquidity.

## Required live setup

1. Put the private key in the deployment secret manager as POLYMARKET_PRIVATE_KEY.
2. Confirm the wallet/funder has USDC and the required CLOB allowance.
3. Keep the dashboard paused while checking authentication and balance.
4. Resume trading only when the live account and current market data are visible.

The service uses live_trader_bridge.js with @polymarket/clob-client-v2, @polymarket/builder-relayer-client, and viem. The Python service owns market discovery, signal timing, pause state, and the dashboard.

Official references:

- https://docs.polymarket.com/trading/place-orders
- https://docs.polymarket.com/trading/orders/overview
- https://docs.polymarket.com/developers/CLOB/orders/get-order
