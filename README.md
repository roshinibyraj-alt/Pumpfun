# Multi-timeframe BTC 5m prediction bot

Paper-trading bot for Polymarket `btc-updown-5m-*` markets. The bot predicts
the direction of the next 5-minute BTC window and buys the **same** side:
an UP prediction buys UP; a DOWN prediction buys DOWN. It never fades the
signal.

## Strategy

At every new 5-minute window:

1. Completed Binance BTC/USDT candles are aggregated into 1D, 4H, 1H and
   15M bars. Partial bars and missing minutes are rejected.
2. Each timeframe is scored using EMA 9/21/50 alignment, RSI(14), MACD,
   ADX, 3- and 10-bar momentum, Bollinger position, ATR volatility, volume
   ratio and candle body.
3. Higher timeframes have more influence: 1D (35%), 4H (30%), 1H (20%) and
   15M (15%). The engine identifies a trend, range or transition regime and
   records the exact reason for the prediction.
4. A pure-Python logistic model is blended with that transparent indicator
   score. It is trained walk-forward: it predicts first, observes the next
   5-minute result, then takes one learning step.
5. The engine buys the predicted side only when confidence and cross-timeframe
   alignment pass the configured thresholds. Weak or conflicting signals are
   skipped instead of forcing a trade.

## One-week walk-forward backtest

At startup, Binance history is fetched for indicator warm-up
(`AI_WARMUP_DAYS`, default 45 days). Only the most recent
`AI_BACKTEST_DAYS` (default 7 days) is used for the reported backtest.
Every historical prediction is made without using its future outcome.

The dashboard and event log report:

- overall prediction accuracy;
- accuracy for each market regime;
- accuracy by UTC hour;
- accuracy by regime/timeframe setup;
- confidence, timeframe alignment and the indicator evidence behind the
  current signal.

One week is the evaluation period, not the entire indicator history. The
longer warm-up is necessary because a daily MACD/EMA calculation cannot be
reliable from only seven daily candles.

## Execution

The execution layer remains paper trading by default:

- one signal-driven entry per 5-minute window;
- wait `ENTRY_DELAY_SECONDS` after the window opens (default 2 seconds);
- immediately buy the predicted side with a taker order using the available
  ask depth;
- TP at `TP_PRICE`;
- force-close at the end of the window if TP is not reached;
- realistic order-book depth and taker fees are used for entry, TP and
  forced-close fills.

## Run locally

```bash
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

Dashboard: `http://localhost:8000`

## Important configuration

- `AI_BACKTEST_DAYS` — walk-forward evaluation period, default `7`.
- `AI_WARMUP_DAYS` — Binance history fetched for indicator warm-up, default
  `45`.
- `AI_MIN_CONFIDENCE` — minimum predicted-side probability, default `0.56`.
- `AI_MIN_ALIGNMENT` — minimum agreement across timeframes, default `0.35`.
- `AI_MODEL_WEIGHT` — learned-model share of the final probability, default
  `0.70`.
- `ORDER_SHARES`, `ENTRY_DELAY_SECONDS`, `TP_PRICE`.

The bot is still configured for paper trading. Review the strategy, fees and
backtest results before using any live funds.