'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Engine = require('./engine');
const Worker = require('./worker');
const LedgerStore = require('../paper-ledger-store');

class ReboundRuntime {
  constructor(main, { directory = path.join(process.env.PAPER_LEDGER_PATH
    ? path.dirname(process.env.PAPER_LEDGER_PATH) : require('node:os').tmpdir(), 'rebound-shadow'),
    now = Date.now } = {}) {
    this.main = main; this.directory = directory; this.now = now;
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
    const spot = feed && Number.isFinite(feed.price) && Number.isFinite(feed.tickAt)
      && feed.tickAt <= now && now - feed.tickAt <= 5000
      && candle?.start === record.market.start
      ? { price: feed.price, at: feed.tickAt, open: candle.open } : null;
    this.engine.observe(record, side, spot);
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
    return { ...this.engine.snapshot(), persistence: this.persistence };
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.worker.stop();
    if (this.originalApplyBook) this.main.applyBook = this.originalApplyBook;
    while (this.inFlight) await new Promise(resolve => setTimeout(resolve, 20));
    if (!this.failedStartup) await this.flush();
  }
}
module.exports = ReboundRuntime;
