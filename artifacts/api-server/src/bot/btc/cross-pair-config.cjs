'use strict';

const WINDOW_MS = 15 * 60 * 1000;

const TIERS = [
  { id: '0.90', label: 'Combined asks < $0.90', threshold: 0.90, strict: true },
  { id: '0.80', label: 'Combined asks ≤ $0.80', threshold: 0.80, strict: false },
  { id: '0.70', label: 'Combined asks ≤ $0.70', threshold: 0.70, strict: false },
  { id: '0.60', label: 'Combined asks ≤ $0.60', threshold: 0.60, strict: false },
  { id: '0.50', label: 'Combined asks ≤ $0.50', threshold: 0.50, strict: false },
];

const PAIRS = [
  {
    id: 'btc-up-eth-down',
    label: 'BTC UP + ETH DOWN',
    legs: [{ asset: 'BTC', side: 'UP' }, { asset: 'ETH', side: 'DOWN' }],
  },
  {
    id: 'eth-up-btc-down',
    label: 'ETH UP + BTC DOWN',
    legs: [{ asset: 'ETH', side: 'UP' }, { asset: 'BTC', side: 'DOWN' }],
  },
];

module.exports = {
  STRATEGY_VERSION: 'cross-pair-arbitrage-15m-v1',
  WINDOW_MS,
  STARTING_CAPITAL: 3_000,
  SHARES_PER_LEG: 100,
  MAX_ENTRY_PRICE: 0.99,
  POLL_INTERVAL_MS: 500,
  MARKET_REFRESH_MS: 10_000,
  RESOLUTION_POLL_MS: 5_000,
  MAX_QUOTE_AGE_MS: 2_000,
  TIERS,
  PAIRS,
};
