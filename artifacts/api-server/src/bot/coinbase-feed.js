'use strict';

const DEFAULT_POLL_MS = 500;
const TICKER_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function priceFromTicker(ticker) {
  if (!ticker || typeof ticker !== 'object') return null;
  const bid = positiveNumber(ticker.bid);
  const ask = positiveNumber(ticker.ask);
  if (bid != null && ask != null && ask >= bid) return (bid + ask) / 2;
  return positiveNumber(ticker.price);
}

class CoinbasePriceFeed {
  constructor(options = {}) {
    this.exchangeId = String(options.exchangeId || 'coinbase').toLowerCase();
    this.symbol = options.symbol || 'BTC/USD';
    this.pollMs = Math.max(100, Number(options.pollMs) || DEFAULT_POLL_MS);
    this.setupError = this.exchangeId !== 'coinbase' || this.symbol.replace('-', '/').toUpperCase() !== 'BTC/USD'
      ? new Error('The demo feed supports Coinbase BTC/USD only.')
      : null;
    this._running = false;
    this._timer = null;
    this._failures = 0;
  }

  start(onPrice, onError = () => {}) {
    if (this._running) return () => this.stop();
    this._running = true;
    this._onPrice = typeof onPrice === 'function' ? onPrice : () => {};
    this._onError = typeof onError === 'function' ? onError : () => {};
    if (this.setupError) {
      this._report(this.setupError);
      return () => this.stop();
    }
    void this._poll();
    return () => this.stop();
  }

  async _poll() {
    if (!this._running) return;
    const sampledAt = Date.now();
    try {
      const response = await fetch(TICKER_URL, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Coinbase ticker returned HTTP ' + response.status);
      const ticker = await response.json();
      const receivedAt = Date.now();
      const price = priceFromTicker(ticker);
      if (price == null) throw new Error('Coinbase ticker did not include a valid BTC price');
      this._failures = 0;
      this._onPrice({
        exchange: 'coinbase',
        symbol: 'BTC/USD',
        price,
        bid: positiveNumber(ticker.bid),
        ask: positiveNumber(ticker.ask),
        last: positiveNumber(ticker.price),
        exchangeTimestamp: ticker.time ? Date.parse(ticker.time) : null,
        sampledAt,
        receivedAt,
      });
    } catch (error) {
      this._failures += 1;
      this._report(error);
    }

    if (!this._running) return;
    const interval = this._failures
      ? Math.min(this.pollMs * (2 ** Math.min(this._failures, 4)), 8000)
      : this.pollMs;
    const delay = Math.max(0, interval - (Date.now() - sampledAt));
    this._timer = setTimeout(() => { void this._poll(); }, delay);
  }

  _report(error) {
    try {
      this._onError(error instanceof Error ? error : new Error(String(error)));
    } catch (_) {}
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}

module.exports = CoinbasePriceFeed;
module.exports.priceFromTicker = priceFromTicker;