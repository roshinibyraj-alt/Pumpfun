// ============================================================
// binance.js — despite the filename (kept so bot.js doesn't
// need edits), this now pulls live price and volatility from
// COINBASE's public API. Binance blocks US-based server IPs
// (which is what Railway uses) with a 451 error, so Coinbase's
// Exchange API is the price feed here instead. No key needed.
// ============================================================

const SYMBOL_MAP = { btc: 'BTC-USD', eth: 'ETH-USD' };

// Coinbase's edge (Cloudflare) sometimes rejects requests with no
// User-Agent header, so we always send one.
const HEADERS = { 'User-Agent': 'btc-fairvalue-bot/1.0' };

async function getSpotPrice(asset) {
  const product = SYMBOL_MAP[asset];
  const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`Coinbase price fetch failed: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.price);
}

// Realized volatility from 1-minute candles, expressed as
// "sigma per minute" (stdev of log returns between consecutive closes).
async function getRealizedVolPerMinute(asset, lookbackMinutes) {
  const product = SYMBOL_MAP[asset];
  const granularitySeconds = 60; // 1-minute candles
  const now = Math.floor(Date.now() / 1000);
  const start = new Date((now - lookbackMinutes * 60) * 1000).toISOString();
  const end = new Date(now * 1000).toISOString();

  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularitySeconds}&start=${start}&end=${end}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Coinbase candles fetch failed: ${res.status}`);
  const candles = await res.json();
  // Each candle: [ time, low, high, open, close, volume ]

  if (!Array.isArray(candles) || candles.length < 3) {
    throw new Error('Coinbase candles: not enough data returned');
  }

  const closes = candles.map((c) => c[4]);
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
