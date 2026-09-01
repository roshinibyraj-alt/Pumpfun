'use strict';
// Headless dashboard render smoke: executes the dashboard <script> against a DOM stub
// and asserts every render function runs without errors (catches missing helpers like $).
'use strict';
// Extract the dashboard <script> from index.js and run it against a DOM stub
const fs = require('fs');
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
const m = src.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('NO SCRIPT FOUND'); process.exit(1); }
let js = m[1];

// Minimal DOM stub
const elements = {};
function makeEl() {
  return { textContent: '', innerHTML: '', className: '', title: '', value: '', style: {} };
}
global.document = {
  getElementById: id => { if (!elements[id]) elements[id] = makeEl(); return elements[id]; },
  createElement: () => makeEl(),
};
global.window = global;
// No fetch — override poll
js = js.replace(/async function poll\(\)\{[^}]*\}\s*setInterval\(poll,1000\);poll\(\);\s*$/, 'async function poll(){}');

// Sample state to render
const sample = {
  limit: {
    connected: true, uptime: 900, lastPollAt: Date.now(), lastError: null,
    capital: 500, totalPnl: 12.5, realizedPnl: 12.5, wins: 3, losses: 1, maxDrawdown: 4.2,
    orders: [{ id: 1, outcome: 'UP', status: 'FILLED', shares: 100, fillPrice: 0.1, totalCost: 9.9 }],
    trades: [{ timestamp: Date.now(), type: 'BUY', outcome: 'UP', shares: 100, price: 0.1, cost: 9.9 }],
    equityCurve: [{ t: Date.now(), equity: 500 }, { t: Date.now(), equity: 512 }],
    logs: ['[00:00:00.000] ✅ BUY FILLED UP 100sh @ $0.10', '[00:00:01.000] 🏁 UP WIN #1'],
    pollCount: 1,
  },
  sniper: {
    connected: true, capital: 150, totalPnl: -2.2, wins: 1, losses: 2, currentBet: 25.13, consecutiveLosses: 2,
    position: { side: 'UP', shares: 11, fillPrice: 0.89, cost: 9.79, windowStart: 123 },
    trades: [{ timestamp: Date.now(), type: 'BUY', outcome: 'UP', shares: 11, price: 0.89, cost: 9.79 }],
    equityCurve: [{ t: Date.now(), equity: 150 }, { t: Date.now(), equity: 148 }],
    logs: ['[00:00:00.000] 🎯SNIPER ENTRY UP 11sh @ $0.89', '[00:00:01.000] 🎯SNIPER RES UP WIN'],
  },
  markets: [{
    windowStart: 100, windowEnd: 400, remaining: 150, resolved: false, winner: null,
    up: { bid: 0.49, ask: 0.51, mid: 0.5, spread: 0.02 },
    down: { bid: 0.49, ask: 0.51, mid: 0.5, spread: 0.02 },
  }],
};

try {
  eval(js + '\n;fullRender(sample);');
  setTimeout(() => {
    // Verify some elements got values
    const checks = ['upPrice', 'dnPrice', 'lbCap', 'sbCap', 'statusPill', 'lastPollPill', 'sbPosCnt', 'lbPosCnt'];
    let ok = true;
    for (const id of checks) {
      const el = elements[id];
      if (!el) { console.log('MISSING ELEMENT:', id); ok = false; continue; }
      console.log(id, '=>', JSON.stringify(el.textContent || el.className));
    }
    if (ok) console.log('✅ DASHBOARD SCRIPT RENDERS WITHOUT ERRORS');
    process.exit(ok ? 0 : 1);
  }, 100);
} catch (e) {
  console.error('❌ DASHBOARD RENDER ERROR:', e.message);
  process.exit(1);
}
