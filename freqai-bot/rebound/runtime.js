'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Engine = require('./engine');
const Worker = require('./worker');
const LedgerStore = require('../paper-ledger-store');

class ReboundRuntime {
  constructor(main, { directory = path.join(process.env.PAPER_LEDGER_PATH
    ? path.dirname(process.env.PAPER_LEDGER_PATH) : require('node:os').tmpdir(), 'rebound-shadow'),
    now = Date.now, fetchImpl = globalThis.fetch } = {}) {
    this.main = main; this.directory = directory; this.now = now;
    this.fetchImpl = fetchImpl; this.spot = null; this.lastSpotPoll = 0;
    this.dataFeed = { status: 'WAITING', source: null, lastError: null };
    this.store = new LedgerStore(path.join(directory, 'ledger.json'));
    this.trainingStore = new LedgerStore(path.join(directory, 'training.json'));
    this.persistence = { configured: true, lastSavedAt: null, lastError: null };
    this.engine = new Engine({ now, changed: () => { this.dirty = true; },
      requestScore: (id, context) => this.worker.score(id, context) });
    this.worker = new Worker(directory, row => {
      if (!this.worker.model.trainedAt || this.now() - this.worker.model.trainedAt > 8 * 3600000) {
        row.probability = null; row.lastError = 'Model has no fresh trained artifact.';
      }
      this.engine.score(row);
      // Model inference never blocks the main bot, and execution has its own delay.
      const timer = setTimeout(() => { if (!this.stopped) this.engine.tick(); }, 350);
      timer.unref?.();
    });
    this.stopped = true; this.dirty = false; this.lastSaveAt = 0;
    this.lastResolutionAt = 0; this.inFlight = false;
  }
  async start() {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const saved = this.store.load();
      if (saved) this.engine.restore(saved);
      else this.engine.log('START', 'Independent $3,000 rebound account created; existing Pumpfun account untouched.');
      await this.flush();
      this.stopped = false;
      const original = this.main.applyBook.bind(this.main);
      this.originalApplyBook = this.main.applyBook;
      this.main.applyBook = (...args) => {
        original(...args);
        try { this.observe(args[0], args[1]); }
        catch (error) { this.engine.lastError = `Shadow observer: ${error.message}`; }
      };
      this.worker.start();
      void this.refreshSpot();
      this.timer = setInterval(() => { void this.tick(); }, 1000);
      this.timer.unref?.();
    } catch (error) {
      this.failedStartup = true;
      this.engine.lastError = `Shadow startup failed: ${error.message}`;
      this.persistence.lastError = error.message;
      console.error('[rebound-shadow]', this.engine.lastError);
    }
  }
  observe(record, side) {
    const feed = this.main.binanceFeed, now = this.now();
    const candle = feed?.currentCandle;
    let spot = feed && Number.isFinite(feed.price) && Number.isFinite(feed.tickAt)
      && feed.tickAt <= now && now - feed.tickAt <= 5000
      && candle?.start === record.market.start
      ? { price: feed.price, at: feed.tickAt, open: candle.open, source: 'BINANCE_WEBSOCKET' } : null;
    if (!spot && this.spot?.start === record.market.start && now >= this.spot.at && now - this.spot.at <= 5000)
      spot = this.spot;
    this.dataFeed = spot ? { status: 'READY', ...spot, lastError: null }
      : { status: 'WAITING', source: null, lastError: this.spotError || feed?.error || 'Waiting for fresh BTC context' };
    this.engine.observe(record, side, spot);
  }
  async refreshSpot() {
    const now = this.now(), feed = this.main.binanceFeed;
    if (this.stopped || this.spotPollInFlight || now - this.lastSpotPoll < 2000) return;
    if (Number.isFinite(feed?.tickAt) && feed.tickAt <= now && now - feed.tickAt <= 2000
      && feed.currentCandle?.start === Math.floor(now / 300000) * 300000
      && feed.currentCandle.open > 0) return;
    this.lastSpotPoll = now; this.spotPollInFlight = true;
    this.spotAbort = new AbortController();
    const timeout = setTimeout(() => this.spotAbort?.abort(), 1500);
    try {
      const response = await this.fetchImpl('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1',
        { signal: this.spotAbort.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Binance public candle HTTP ${response.status}`);
      const rows = await response.json(), row = rows?.[0], at = this.now();
      const start = Number(row?.[0]), open = Number(row?.[1]), price = Number(row?.[4]);
      if (at - now > 1500 || start !== Math.floor(at / 300000) * 300000 || !(open > 0 && price > 0))
        throw new Error('Binance fallback returned stale or invalid forming-candle data');
      this.spot = { start, open, price, at, source: 'BINANCE_PUBLIC_REST_FORMING_CANDLE' };
      this.spotError = null;
    } catch (error) { this.spotError = String(error.message).slice(0, 200); }
    finally { clearTimeout(timeout); this.spotPollInFlight = false; this.spotAbort = null; }
  }
  async flush() {
    const snapshot = this.engine.export();
    await this.store.save(snapshot);
    await this.trainingStore.save(snapshot.examples);
    this.persistence.lastSavedAt = this.now(); this.persistence.lastError = null;
    this.lastSaveAt = this.now(); this.dirty = false;
  }
  async tick() {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      this.engine.model = this.worker.snapshot();
      void this.refreshSpot();
      this.engine.tick();
      if (this.now() - this.lastResolutionAt >= 10000) {
        this.lastResolutionAt = this.now();
        const pending = new Map(this.engine.positions.filter(p => p.status === 'PENDING_RESOLUTION')
          .map(p => [p.marketId, p]));
        for (const [marketId, sample] of [...pending].slice(0, 4)) {
          try {
            const market = await this.main.marketData.getMarket(marketId);
            const winner = this.main.marketData.resolvedWinner(market);
            if (winner) this.engine.settle(marketId, winner);
            sample.resolutionError = null;
          } catch (error) { sample.resolutionError = String(error.message).slice(0, 200); }
        }
      }
      if (this.dirty && this.now() - this.lastSaveAt >= 2000) await this.flush();
    } catch (error) {
      this.persistence.lastError = error.message;
      console.error('[rebound-shadow]', error.message);
    } finally { this.inFlight = false; }
  }
  snapshot() {
    this.engine.model = this.worker.snapshot();
    return { ...this.engine.snapshot(), persistence: this.persistence, dataFeed: this.dataFeed };
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.worker.stop();
    this.spotAbort?.abort();
    if (this.originalApplyBook) this.main.applyBook = this.originalApplyBook;
    while (this.inFlight) await new Promise(resolve => setTimeout(resolve, 20));
    if (!this.failedStartup) await this.flush();
  }
}
module.exports = ReboundRuntime;
