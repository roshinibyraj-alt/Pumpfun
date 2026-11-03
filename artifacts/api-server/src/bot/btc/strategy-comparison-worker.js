'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { compareStrategies } = require('./strategy-comparison');

try {
  parentPort.postMessage({ report: compareStrategies(workerData) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
