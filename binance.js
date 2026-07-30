// ============================================================
// binance.js — pulls live BTC/ETH price and recent volatility
// from Binance's PUBLIC API (no key or account needed).
// This is our independent "ground truth" price feed, separate
// from whatever Polymarket's market is currently pricing.
// ============================================================

const SYMBOL_MAP = { btc: 'BTCUSDT', eth: 'ETHUSDT' };

async function getSpotPrice(asset) {
  const symbol = SYMBOL_MAP[asset];
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance price fetch failed: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.price);
}

// Realized volatility from 1-minute candles, expressed as
// "sigma per minute" (stdev of log returns between consecutive closes).
async function getRealizedVolPerMinute(asset, lookbackMinutes) {
  const symbol = SYMBOL_MAP[asset];
  const limit = Math.min(lookbackMinutes + 1, 1000);
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`
  );
  if (!res.ok) throw new Error(`Binance klines fetch failed: ${res.status}`);
  const candles = await res.json();

  const closes = candles.map((c) => parseFloat(c[4])); // close price is index 4
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);

  return Math.sqrt(variance); // sigma per 1-minute step
}

module.exports = { getSpotPrice, getRealizedVolPerMinute };
