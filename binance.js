// ============================================================
// candles.js — fetches real OHLC candles for the underlying asset
// from Binance's public REST API (no key required). This is
// deliberately independent from polymarket.js: the Polymarket
// UP/DOWN token price is a derived prediction-market price, not the
// actual BTC/ETH price, so pattern detection needs its own real
// price feed.
// ============================================================

const BINANCE_SYMBOLS = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
};

function binanceSymbol(asset) {
  const symbol = BINANCE_SYMBOLS[String(asset).toLowerCase()];
  if (!symbol) {
    throw new Error(`No Binance symbol mapping for asset "${asset}" (add it to BINANCE_SYMBOLS in candles.js)`);
  }
  return symbol;
}

// Returns the most recent `limit` CLOSED candles (oldest first, most
// recent last) as { openTime, open, high, low, close, volume, closeTime }.
// Explicitly drops any still-forming candle (closeTime in the future),
// since that one's color can still flip before it closes.
async function getRecentClosedCandles(asset, interval, limit) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available — Node 18+ is required (or install/polyfill node-fetch)');
  }
  const symbol = binanceSymbol(asset);
  // Ask for a couple extra in case the most recent bar returned is
  // still forming — we filter it out below rather than trust `limit`
  // to exactly match closed candles.
  const fetchLimit = limit + 2;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${fetchLimit}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance klines request failed: ${res.status} ${res.statusText}`);
  }
  const raw = await res.json();

  const nowMs = Date.now();
  const candles = raw
    .map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }))
    .filter((c) => c.closeTime <= nowMs);

  return candles.slice(-limit);
}

module.exports = { binanceSymbol, getRecentClosedCandles };
