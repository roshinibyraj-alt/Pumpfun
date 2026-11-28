'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Engine = require('./engine');
const LedgerStore = require('../paper-ledger-store');

class ShadowLadderRuntime {
  constructor(main, { directory = path.join(process.env.PAPER_LEDGER_PATH
    ? path.dirname(process.env.PAPER_LEDGER_PATH) : require('node:os').tmpdir(), 'shadow-first70-stop40-reset-v1'),
    now = Date.now } = {}) {
    this.main = main; this.directory = directory; this.now = now;
    this.store = new LedgerStore(path.join(directory, 'ledger.json'));
    this.engine = new Engine({ now, changed: () => { this.dirty = true; } });
    this.persistence = { configured: true, lastSavedAt: null, lastError: null };
    this.dataFeed = { status: 'WAITING', lastError: null };
    this.stopped = true; this.dirty = false; this.lastSaveAt = 0;
    this.lastResolutionAt = 0; this.resolutionCursor = 0; this.inFlight = false;
  }
  async start() {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const saved = this.store.load();
      if (saved) this.engine.restore(saved);
      else this.engine.log('START', 'Reset independent $3,000 shadow account: first side bid >= $0.70 requests 300 shares immediately; no $0.33 prerequisite. Final-two-minute cutoff, $0.40 stop and final-30-second exit unchanged. Main account unchanged.');
      await this.flush();
      this.stopped = false;
      const original = this.main.applyBook.bind(this.main);
      this.originalApplyBook = this.main.applyBook;
      this.main.applyBook = (...args) => {
        original(...args);
        try {
          this.engine.observe(args[0], args[1]);
          const w = this.engine.current && this.engine.windows[String(this.engine.current.windowStart)];
          const fresh = Object.values(w?.quotes || {}).some(q => this.engine.fresh(q));
          this.dataFeed = { status: fresh ? 'READY' : 'WAITING', lastError: null };
        } catch (error) {
          this.engine.lastError = `Shadow observer: ${error.message}`;
          this.dataFeed = { status: 'ERROR', lastError: error.message };
        }
      };
      this.timer = setInterval(() => { void this.tick(); }, 1000);
      this.timer.unref?.();
    } catch (error) {
      this.failedStartup = true;
      this.engine.lastError = `Shadow startup failed: ${error.message}`;
      this.persistence.lastError = error.message;
      console.error('[shadow-ladder]', this.engine.lastError);
    }
  }
  async flush() {
    await this.store.save(this.engine.export());
    this.persistence.lastSavedAt = this.now(); this.persistence.lastError = null;
    this.lastSaveAt = this.now(); this.dirty = false;
  }
  async tick() {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      this.engine.tick();
      if (this.now() - this.lastResolutionAt >= 10000) {
        this.lastResolutionAt = this.now();
        const pending = [...new Map(this.engine.positions.filter(p => p.status === 'PENDING_RESOLUTION')
          .map(p => [p.marketId, p])).entries()];
        if (pending.length) {
          const batch = Array.from({ length: Math.min(4, pending.length) }, (_, i) =>
            pending[(this.resolutionCursor + i) % pending.length]);
          this.resolutionCursor = (this.resolutionCursor + batch.length) % pending.length;
          for (const [marketId, sample] of batch) {
            try {
              const market = await this.main.marketData.getMarket(marketId);
              const winner = this.main.marketData.resolvedWinner(market);
              if (winner) this.engine.settle(marketId, winner);
              sample.resolutionError = null;
            } catch (error) { sample.resolutionError = String(error.message).slice(0, 200); }
          }
        }
      }
      if (this.dirty && this.now() - this.lastSaveAt >= 2000) await this.flush();
    } catch (error) {
      this.persistence.lastError = error.message;
      this.engine.lastError = `Shadow update failed: ${error.message}`;
      console.error('[shadow-ladder]', error.message);
    } finally { this.inFlight = false; }
  }
  snapshot() {
    const state = this.engine.snapshot();
    const quotes = state.market?.quotes || {};
    return { ...state, persistence: this.persistence,
      dataFeed: { ...this.dataFeed, status: Object.values(quotes).some(Boolean) ? this.dataFeed.status : 'WAITING' } };
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer);
    if (this.originalApplyBook) this.main.applyBook = this.originalApplyBook;
    while (this.inFlight) await new Promise(resolve => setTimeout(resolve, 20));
    if (!this.failedStartup) await this.flush();
  }
}
module.exports = ShadowLadderRuntime;
