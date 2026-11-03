---
name: BTC MACD paper bot
description: User-approved fixed window signal, timed sizing, and retained exit constraints.
---

## Fixed window MACD policy

Every five-minute paper window uses only its immediately preceding, fully closed five-minute MACD histogram candle (standard 12/26/9). SHRINKING_RED and SOLID_GREEN choose UP; SHRINKING_GREEN and SOLID_RED choose DOWN. A neutral candle skips; missing, stale or unfinished prior-candle data must not fall back to an older bar. Lock the decision for that window; later bars cannot flip it or carry it to the next window.

Buy 50 shares at 10, 20, …, 290 elapsed seconds inclusive: 29 scheduled opportunities, up to 1,450 shares if every entry fills. No probability model or probability-derived edge gate. No opposite-signal selling and no matched reversals. Keep all other entry gates and TP/SL unchanged.

**Why:** The user replaced the first-two-one-minute-bar rule with the previous closed five-minute candle and confirmed entries from 10 through 290 seconds. This supersedes earlier candle-pair, delayed-entry, carry-over, adaptive-sizing and reversal rules.

**How to apply:** Treat signal timeframe, one-bar mapping, 50-share size and the 10–290 second schedule as fixed requirements, not tunable parameters. Keep persistent learning logs and regression observational only. Never restore old stored tuning or old direction at startup. Compatible regression must use the same live policy, including actual quote timestamps, and exclude samples from older strategies.

## Retained execution safeguards

Paper-only operation, cash checks, existing $0.02 best-ask floor, real visible liquidity, fees, own-side TP/SL and original-market expiry recovery remain active. A failed or missed scheduled slot must not generate a catch-up burst. Keep the live histogram large and bold, but distinguish the latest histogram classification from the window's locked decision.

**Why:** The confirmed request retained existing TP/SL. Earlier every-scan accumulation caused unwanted 100-share-per-second buys; the new schedule must not recreate that failure.

**How to apply:** TP uses own-side bid at least $0.99 and credits $1/share; SL uses bid at most $0.01 and credits $0/share, before fees. TP/SL closes a lot, not the locked window decision. Scheduled later entries may still occur on that same side.

## Original-market expiry

Expired paper lots must keep retrying their original outcome token/market when a fresh closing mark is missing. A newly fetched original-token bid is a recovery mark, not a historical close; confirmed binary market resolution can redeem its exact payout when the book is gone. If neither source is available, show pending settlement rather than inventing a fill. Never use the next window's same-named side to settle an old position.

**Why:** Old lots remained open after their last bid arrived outside the five-second expiry freshness limit and polling switched to the new market. Substituting a new window's price would fabricate P&L.

**How to apply:** Keep recovery source labels and fee treatment explicit; confirmed outcome redemption is not a CLOB sale.

## PostgreSQL timestamp arithmetic

Millisecond epoch values need explicit 64-bit typing in PostgreSQL arithmetic and comparisons; otherwise an untyped parameter combined with integer literals may be inferred as a 32-bit integer and overflow.

**Why:** The production learning endpoint failed when it compared epoch-millisecond timestamps, despite the stored columns being BIGINT.

**How to apply:** Cast timestamp parameters and arithmetic constants to BIGINT; keep a regression test for large epoch values.
