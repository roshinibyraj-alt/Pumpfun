---
name: Polymarket maker rebate accounting
description: Current Crypto fee-equivalent and maker-rebate behavior used by the paper model.
---

Polymarket Crypto markets use a fee-equivalent curve of `shares × 0.07 × price × (1 - price)`; the documented maker-rebate share is 20%.

**Why:** Makers pay no trading fee, but rebates are distributed daily from a market-wide pool and require minimum accrued payout, so a per-fill amount is an estimate rather than a guaranteed immediate payment.

**How to apply:** Keep maker rebates separate from taker fees, label paper values as accrued estimates, and re-check the official market fee schedule before treating them as live settlement cash.