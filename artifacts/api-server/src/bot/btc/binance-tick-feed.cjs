'use strict';

const CANDLE_MS = 5 * 60 * 1000;
const HISTORY_URL = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=5';
const STREAM_URL = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

function parseClosedCandles(rows, now) {
  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    const start = Number(row?.[0]);
    const open = Number(row?.[1]);
    const high = Number(row?.[2]);
    const low = Number(row?.[3]);
    const close = Number(row?.[4]);
    if (!Number.isFinite(start)
      || ![open, high, low, close].every(value => Number.isFinite(value) && value > 0)) {
      return [];
    }
    const end = start + CANDLE_MS;
    return [{
      start,
      end,
      open,
      high,
      low,
      close,
      closed: end <= now,
      logReturn: Math.log(close / open),
    }];
  });
}

class BinanceTickFeed {
  constructor({
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    onUpdate = () => {},
  } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.onUpdate = onUpdate;
    this.started = false;
    this.socket = null;
    this.retryTimer = null;
    this.historyTimer = null;
    this.reconnectCount = 0;
    this.retryMs = RECONNECT_MIN_MS;
    this.status = 'WAITING';
    this.error = null;
    this.historyStatus = 'WAITING';
    this.historyError = null;
    this.closedCandles = [];
    this.currentCandle = null;
    this.price = null;
    this.tickAt = null;
  }

  async start() {
    if (this.started) return this.snapshot();
    this.started = true;
    await this.refreshHistory();
    this.connect();
    this.scheduleHistoryRefresh();
    return this.snapshot();
  }

  stop() {
    this.started = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.historyTimer);
    this.retryTimer = null;
    this.historyTimer = null;
    try {
      this.socket?.close();
    } catch {
      // The feed is already stopped.
    }
    this.socket = null;
    this.status = 'STOPPED';
  }

  async refreshHistory() {
    if (typeof this.fetchImpl !== 'function') {
      this.historyStatus = 'ERROR';
      this.historyError = 'Binance candle history is unavailable.';
      this.notify();
      return false;
    }
    this.historyStatus = 'LOADING';
    try {
      const response = await this.fetchImpl(HISTORY_URL, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Binance candle request failed (${response.status}).`);
      const rows = await response.json();
      const parsed = parseClosedCandles(rows, this.now());
      this.closedCandles = parsed.filter(candle => candle.closed).slice(-3);
      this.currentCandle = parsed.find(candle => !candle.closed) || null;
      this.historyStatus = this.closedCandles.length === 3 ? 'READY' : 'INSUFFICIENT_HISTORY';
      this.historyError = null;
      this.notify();
      return this.historyStatus === 'READY';
    } catch (error) {
      this.historyStatus = 'ERROR';
      this.historyError = error?.message || 'Binance candle request failed.';
      this.notify();
      return false;
    }
  }

  scheduleHistoryRefresh() {
    clearTimeout(this.historyTimer);
    if (!this.started) return;
    const now = this.now();
    const nextBoundary = Math.floor(now / CANDLE_MS) * CANDLE_MS + CANDLE_MS;
    this.historyTimer = setTimeout(async () => {
      this.historyTimer = null;
      await this.refreshHistory();
      this.scheduleHistoryRefresh();
    }, Math.max(250, nextBoundary - now + 300));
    this.historyTimer.unref?.();
  }

  connect() {
    if (!this.started) return;
    if (typeof this.WebSocketImpl !== 'function') {
      this.status = 'ERROR';
      this.error = 'This Node runtime does not provide WebSocket support.';
      this.notify();
      return;
    }
    this.status = 'CONNECTING';
    this.error = null;
    try {
      const socket = new this.WebSocketImpl(STREAM_URL);
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (!this.started || this.socket !== socket) return;
        this.status = 'CONNECTED';
        this.error = null;
        this.retryMs = RECONNECT_MIN_MS;
        this.reconnectCount = 0;
        this.notify();
      });
      socket.addEventListener('message', event => {
        if (!this.started || this.socket !== socket) return;
        void this.handleMessage(event?.data);
      });
      socket.addEventListener('error', () => {
        if (!this.started || this.socket !== socket) return;
        this.status = 'ERROR';
        this.error = 'Binance tick stream reported an error.';
        this.notify();
      });
      socket.addEventListener('close', () => {
        if (!this.started || this.socket !== socket) return;
        this.socket = null;
        this.status = 'DISCONNECTED';
        this.scheduleReconnect();
      });
    } catch (error) {
      this.status = 'ERROR';
      this.error = error?.message || 'Binance tick stream could not start.';
      this.scheduleReconnect();
    }
    this.notify();
  }

  scheduleReconnect() {
    if (!this.started || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    this.reconnectCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
    this.notify();
  }

  async handleMessage(raw) {
    try {
      const text = typeof raw === 'string' ? raw : await raw?.text?.();
      const event = JSON.parse(String(text || ''));
      const price = Number(event?.p);
      const timestamp = Number(event?.T ?? event?.E);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) return;
      this.price = price;
      this.tickAt = timestamp;
      const start = Math.floor(timestamp / CANDLE_MS) * CANDLE_MS;
      if (this.currentCandle?.start !== start) {
        this.currentCandle = {
          start,
          end: start + CANDLE_MS,
          open: price,
          high: price,
          low: price,
          close: price,
          closed: false,
          logReturn: 0,
        };
      } else if (this.currentCandle) {
        this.currentCandle.high = Math.max(this.currentCandle.high, price);
        this.currentCandle.low = Math.min(this.currentCandle.low, price);
        this.currentCandle.close = price;
      }
      this.notify();
    } catch (error) {
      this.error = error?.message || 'Could not parse a Binance tick.';
      this.notify();
    }
  }

  snapshot() {
    return {
      symbol: 'BTCUSDT',
      status: this.status,
      error: this.error,
      reconnectCount: this.reconnectCount,
      price: this.price,
      tickAt: this.tickAt,
      tickAgeMs: this.tickAt == null ? null : Math.max(0, this.now() - this.tickAt),
      historyStatus: this.historyStatus,
      historyError: this.historyError,
      candles: this.closedCandles.slice(-3).map(candle => ({ ...candle })),
      currentCandle: this.currentCandle ? { ...this.currentCandle } : null,
    };
  }

  notify() {
    try {
      this.onUpdate(this.snapshot());
    } catch {
      // Data consumers must not interrupt the exchange feed.
    }
  }
}

module.exports = {
  BinanceTickFeed,
  CANDLE_MS,
  STREAM_URL,
  parseClosedCandles,
};
