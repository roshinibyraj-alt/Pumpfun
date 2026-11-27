'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
class ReboundWorker {
  constructor(directory, onScore) {
    this.directory = directory; this.onScore = onScore;
    this.model = { status: 'STOPPED', lastError: null };
    this.child = null; this.buffer = ''; this.stopped = true;
  }
  start() {
    this.stopped = false;
    this.model.status = 'TRAINING';
    this.child = spawn(process.env.PYTHON_BIN || 'python3', ['-u', path.join(__dirname, 'model.py'), this.directory], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' },
    });
    const child = this.child;
    this.child.stdout.on('data', data => {
      this.buffer += String(data);
      if (this.buffer.length > 1000000) { this.model.lastError = 'Oversized worker output'; this.buffer = ''; }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const row = JSON.parse(line);
          if (row.type === 'model') this.model = { ...this.model, ...row.model, status: row.status, lastError: null };
          else if (row.type === 'status') this.model = { ...this.model, ...row };
          else if (row.type === 'score') this.onScore(row);
        } catch (error) { this.model.lastError = String(error.message).slice(0, 150); }
      }
    });
    this.child.stderr.on('data', data => { this.model.lastError = String(data).slice(-500); });
    this.child.stdin.on('error', error => { this.model.lastError = error.message; });
    const failed = error => {
      if (this.child !== child) return;
      clearTimeout(this.retrain);
      this.model.status = 'ERROR'; this.model.lastError = String(error.message || error).slice(0, 300);
      this.child = null;
      if (!this.stopped) this.retry = setTimeout(() => this.start(), 30000);
    };
    this.child.once('error', failed);
    this.child.once('exit', code => { if (!this.stopped) failed(new Error(`Rebound worker exited: ${code}`)); });
    this.retrain = setTimeout(() => this.restart(), 21600000);
    this.retrain.unref?.();
  }
  score(id, context) {
    if (!this.child?.stdin?.writable || this.child.stdin.writableLength > 1000000) return false;
    this.child.stdin.write(JSON.stringify({ id, context }) + '\n'); return true;
  }
  restart() { this.stop(); this.start(); }
  stop() {
    this.stopped = true; clearTimeout(this.retry); clearTimeout(this.retrain);
    this.child?.removeAllListeners('exit'); this.child?.kill('SIGTERM'); this.child = null;
  }
  snapshot() { return { ...this.model }; }
}
module.exports = ReboundWorker;
