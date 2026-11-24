'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
class Store {
  constructor() { this.status = 'STARTING'; this.error = null; this.chain = Promise.resolve(); }
  async open() {
    if (process.env.DATABASE_URL) {
      const requireDb = createRequire(path.resolve(__dirname, '../../../lib/db/package.json'));
      const { Pool } = requireDb('pg');
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 8000 });
      await this.pool.query('CREATE TABLE IF NOT EXISTS cricket_manual_paper_state (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
      const result = await this.pool.query('SELECT state FROM cricket_manual_paper_state WHERE id=$1', ['v1']);
      this.status = 'POSTGRES_CONNECTED';
      return result.rows[0]?.state;
    }
    this.file = path.resolve(process.cwd(), '.local/cricket-paper-ledger.json');
    this.status = 'LOCAL_FILE';
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  save(data) {
    const serialized = JSON.stringify(data);
    const work = this.chain.catch(() => {}).then(async () => {
      try {
        if (this.pool) await this.pool.query(
          'INSERT INTO cricket_manual_paper_state (id,state) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()', ['v1', serialized]);
        else {
          await fs.mkdir(path.dirname(this.file), { recursive: true });
          await fs.writeFile(`${this.file}.tmp`, serialized);
          await fs.rename(`${this.file}.tmp`, this.file);
        }
        this.error = null;
      } catch (err) { this.error = 'Paper ledger could not be saved. New orders are paused.'; throw new Error(this.error); }
    });
    this.chain = work;
    return work;
  }
  async close() { await this.chain.catch(() => {}); if (this.pool) await this.pool.end(); }
}
module.exports = { Store };
