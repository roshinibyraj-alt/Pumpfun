'use strict';

const BINANCE_DATA = 'https://data-api.binance.vision/api/v3/klines';
const TIMEFRAMES = Object.freeze([
  { key: '15m', interval: '15m', durationMs: 15 * 60_000, limit: 64, required: true },
  { key: '1h', interval: '1h', durationMs: 60 * 60_000, limit: 32, required: true },
  { key: '4h', interval: '4h', durationMs: 4 * 60 * 60_000, limit: 16, required: false },
]);

function parseKlines(rows, durationMs, now) {
  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    const start = Number(row?.[0]);
    const open = Number(row?.[1]);
    const high = Number(row?.[2]);
    const low = Number(row?.[3]);
    const close = Number(row?.[4]);
    const closeTime = Number(row?.[6]);
    if (!Number.isFinite(start) || ![open, high, low, close].every(
      value => Number.isFinite(value) && value > 0,
    )) return [];
    const end = Number.isFinite(closeTime) ? closeTime + 1 : start + durationMs;
    if (end > start + durationMs + 1 || end <= start) return [];
    return [{
      start,
      end,
      open,
      high,
      low,
      close,
      closed: end <= now,
      returnPct: ((close / open) - 1) * 100,
      rangePct: ((high - low) / open) * 100,
    }];
  }).sort((left, right) => left.start - right.start);
}

class BinanceMultiTimeframeFeed {
  constructor({
    fetchImpl = globalThis.fetch,
    now = Date.now,
    pollIntervalMs = 60_000,
    requestTimeoutMs = 8_000,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.started = false;
    this.timer = null;
    this.refreshInFlight = null;
    this.status = 'WAITING';
    this.error = null;
    this.contextError = null;
    this.lastUpdatedAt = null;
    this.candles = { '15m': [], '1h': [], '4h': [] };
  }

  async start() {
    if (this.started) return this.snapshot();
    this.started = true;
    await this.refresh();
    this.scheduleRefresh();
    return this.snapshot();
  }

  stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.status = 'STOPPED';
  }

  async fetchTimeframe(timeframe) {
    const url = new URL(BINANCE_DATA);
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('interval', timeframe.interval);
    url.searchParams.set('limit', String(timeframe.limit));
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Binance ${timeframe.interval} candles returned HTTP ${response.status}.`);
    }
    return parseKlines(await response.json(), timeframe.durationMs, this.now())
      .filter(candle => candle.closed)
      .slice(-timeframe.limit);
  }

  async refresh() {
    if (typeof this.fetchImpl !== 'function') {
      this.status = 'ERROR';
      this.error = 'Binance candle history is unavailable in this runtime.';
      return false;
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    this.status = this.lastUpdatedAt == null ? 'LOADING' : this.status;
    this.refreshInFlight = (async () => {
      const results = await Promise.allSettled(TIMEFRAMES.map(async timeframe => ({
        key: timeframe.key,
        candles: await this.fetchTimeframe(timeframe),
      })));
      const failures = [];
      const contextFailures = [];
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          this.candles[result.value.key] = result.value.candles;
        } else {
          const timeframe = TIMEFRAMES[index];
          const message = result.reason?.message || `A Binance ${timeframe.interval} candle request failed.`;
          if (timeframe.required) failures.push(message);
          else contextFailures.push(message);
        }
      }
      if (failures.length) {
        this.status = this.lastUpdatedAt == null ? 'ERROR' : 'STALE';
        this.error = failures.join(' ');
        return false;
      }
      this.lastUpdatedAt = this.now();
      this.status = 'READY';
      this.error = null;
      this.contextError = contextFailures.join(' ') || null;
      return true;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  scheduleRefresh() {
    clearTimeout(this.timer);
    if (!this.started) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.refresh();
      this.scheduleRefresh();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  snapshot() {
    return {
      symbol: 'BTCUSDT',
      source: 'Binance public klines',
      status: this.status,
      error: this.error,
      contextError: this.contextError,
      lastUpdatedAt: this.lastUpdatedAt,
      ageMs: this.lastUpdatedAt == null
        ? null : Math.max(0, this.now() - this.lastUpdatedAt),
      candles: {
        '15m': this.candles['15m'].map(candle => ({ ...candle })),
        '1h': this.candles['1h'].map(candle => ({ ...candle })),
        '4h': this.candles['4h'].map(candle => ({ ...candle })),
      },
    };
  }
}

module.exports = {
  BinanceMultiTimeframeFeed,
  BINANCE_DATA,
  TIMEFRAMES,
  parseKlines,
};
