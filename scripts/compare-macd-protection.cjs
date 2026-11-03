#!/usr/bin/env node
'use strict';

// The deployed read-only endpoint returns aggregates, never database credentials
// or raw quote histories. An exported windows JSON can also be replayed offline.
const fs = require('node:fs/promises');
const { compareStrategies } = require('../artifacts/api-server/src/bot/btc/strategy-comparison');

async function main() {
  const source = process.argv[2];
  const output = process.argv[3];
  if (!source) throw new Error('Usage: node scripts/compare-macd-protection.cjs <app-url|windows.json> [report.json]');
  let report;
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(new URL('/api/strategy/comparison', source), { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`Comparison endpoint returned HTTP ${response.status}`);
    report = await response.json();
  } else {
    const windows = JSON.parse(await fs.readFile(source, 'utf8'));
    if (!Array.isArray(windows)) throw new Error('Input must be an array of logged windows');
    report = compareStrategies(windows);
  }
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
