'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');

function comparisonService(store, { clock = Date.now } = {}) {
  let pending = null, cache = null, cachedAt = 0;
  return async function getComparison() {
    if (cache && clock() - cachedAt < 300000) return cache;
    if (pending) return pending;
    pending = (async () => {
      const windows = await store.getCompletedWindows(clock(), 120);
      const report = await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'strategy-comparison-worker.js'), { workerData: windows });
        const timer = setTimeout(() => {
          void worker.terminate();
          reject(new Error('Strategy comparison exceeded its 60-second computation limit'));
        }, 60000);
        worker.once('message', message => {
          clearTimeout(timer);
          void worker.terminate();
          if (message.error) reject(new Error(message.error));
          else resolve(message.report);
        });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', code => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`Comparison worker exited with code ${code}`));
        });
      });
      cache = { ...report, generatedAt: clock() };
      cachedAt = clock();
      return cache;
    })().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { comparisonService };
