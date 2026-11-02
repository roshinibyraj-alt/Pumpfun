'use strict';

const TAKE_PROFIT_BID = 0.99;
const STOP_LOSS_BID = 0.01;
const RECOVERY_INTERVAL_MS = 10_000;

function thresholdExit(bid) {
  if (!Number.isFinite(bid) || bid < 0 || bid > 1) return null;
  if (bid >= TAKE_PROFIT_BID) return { price: 1, outcome: 'TAKE_PROFIT' };
  if (bid <= STOP_LOSS_BID) return { price: 0, outcome: 'STOP_LOSS' };
  return null;
}

function array(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function resolvedPayout(market, trade) {
  if (!market || String(market.id) !== String(trade.marketId)
    || market.closed !== true || market.umaResolutionStatus !== 'resolved') return null;
  const prices = array(market.outcomePrices).map(value => value === '0' || value === '1' ? Number(value) : value);
  const tokens = array(market.clobTokenIds || market.outcomeTokenIds);
  const outcomes = array(market.outcomes);
  if (prices.length !== 2 || !prices.every(price => price === 0 || price === 1)
    || prices[0] + prices[1] !== 1) return null;
  const index = trade.tokenId
    ? tokens.findIndex(token => String(token) === String(trade.tokenId))
    : outcomes.findIndex(outcome => String(outcome).toUpperCase() === trade.side);
  return index >= 0 && index < prices.length ? prices[index] : null;
}

// Recover the original market, never the next window's same-named UP/DOWN token.
async function recoverExpiredPositions(bot, now) {
  const groups = new Map();
  for (const trade of bot.trades) {
    if (trade.status !== 'OPEN' || !Number.isFinite(trade.windowEnd) || trade.windowEnd > now) continue;
    const key = String(trade.marketId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  for (const key of bot.expiryRecoveryAt.keys()) {
    if (!groups.has(key)) bot.expiryRecoveryAt.delete(key);
  }
  const due = [...groups].filter(([key]) =>
    !bot.expiryRecoveryAt.has(key) || now - bot.expiryRecoveryAt.get(key) >= RECOVERY_INTERVAL_MS).slice(0, 4);
  await Promise.all(due.map(async ([marketId, trades]) => {
    bot.expiryRecoveryAt.set(marketId, now);
    let market = null;
    let error = null;
    try { market = await bot.fetchMarketDetails(marketId); } catch (cause) { error = cause.message; }
    const books = new Map();
    await Promise.all([...new Set(trades.map(trade => trade.tokenId).filter(Boolean))].map(async tokenId => {
      if (trades.filter(trade => trade.tokenId === tokenId).every(trade => resolvedPayout(market, trade) != null)) return;
      try { books.set(tokenId, bot.quote(await bot.fetchBook(tokenId), bot.now())); }
      catch (cause) { error = cause.message; }
    }));
    for (const trade of trades) {
      if (trade.status !== 'OPEN') continue;
      const payout = resolvedPayout(market, trade);
      if (payout != null) {
        bot.closeTrade(trade, payout, trade.shares * payout, 'MARKET_RESOLUTION',
          'Original market confirmed closed and resolved; redeemed the exact outcome-token payout (no CLOB sale fee).',
          bot.now(), payout);
        continue;
      }
      const quote = books.get(trade.tokenId);
      const bid = quote?.bestBid;
      const checkedAt = bot.now();
      if (Number.isFinite(bid) && bid >= 0 && bid <= 1 && checkedAt >= quote.updatedAt
        && checkedAt - quote.updatedAt <= 5_000) {
        const exit = thresholdExit(bid);
        trade.lastOutcomeBid = bid;
        trade.lastOutcomeBidAt = quote.updatedAt;
        const price = exit?.price ?? bid;
        bot.closeTrade(trade, price, trade.shares * price, exit?.outcome ?? 'WINDOW_RECOVERY_EXIT',
          'Expired paper position recovered using a newly fetched original-token CLOB bid; this is not a historical closing-price claim.',
          checkedAt, bid);
      } else {
        const wasPending = trade.settlementStatus === 'AWAITING_SETTLEMENT';
        trade.settlementStatus = 'AWAITING_SETTLEMENT';
        trade.settlementLastCheckedAt = checkedAt;
        trade.settlementError = error || 'No valid original-token bid or confirmed final outcome; retrying.';
        if (!wasPending) bot.log('EXPIRY_RECOVERY_PENDING', { tradeId: trade.id, marketId, reason: trade.settlementError });
      }
    }
  }));
}

module.exports = { TAKE_PROFIT_BID, STOP_LOSS_BID, thresholdExit, resolvedPayout, recoverExpiredPositions };
