'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

(async () => {
  console.log('=== Dashboard Smoke Test (live CLOB) ===');
  const port = 8123;
  const server = spawn('node', ['index.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', d => log += d.toString());
  server.stderr.on('data', d => log += d.toString());

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let state = null;
  let found = false;
  const startT = Date.now();

  // Poll /api/status until connected with prices
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const r = await fetch(`http://localhost:${port}/api/status`, { cache: 'no-store' });
      state = await r.json();
      const m = state.markets && state.markets[0];
      if (m && m.up.mid != null && m.down.mid != null) { found = true; break; }
    } catch (e) {}
  }
  const elapsed = Math.round((Date.now() - startT) / 1000);

  // 1. Prices populated
  assert.ok(found, `prices appeared on dashboard within 60s (elapsed ${elapsed}s)`);
  const m = state.markets[0];
  console.log(`  ✓ prices from CLOB in ${elapsed}s`);
  console.log(`    UP bid=${m.up.bid} ask=${m.up.ask} mid=${m.up.mid}`);
  console.log(`    DOWN bid=${m.down.bid} ask=${m.down.ask} mid=${m.down.mid}`);
  assert.ok(Number.isFinite(Number(m.up.mid)) && Number(m.up.mid) > 0 && Number(m.up.mid) <= 1, 'UP mid valid');
  assert.ok(Number.isFinite(Number(m.down.mid)) && Number(m.down.mid) > 0 && Number(m.down.mid) <= 1, 'DOWN mid valid');

  // 2. Dashboard HTML contains price slots + poll loop
  const html = await (await fetch(`http://localhost:${port}/`)).text();
  assert.ok(html.includes('upPrice') && html.includes('dnPrice'), 'dashboard has up/down price slots');
  assert.ok(html.includes('renderMarket') && html.includes('fetch(\'/api/status\',{cache'), 'dashboard renders market + polls /api/status');
  console.log('  ✓ dashboard HTML has upPrice/dnPrice + renderMarket + 1s poll loop');

  // 3. Bot connected status accurate
  assert.equal(state.limit.connected, true, 'LimitBot connected');
  assert.ok(state.limit.pollCount >= 1, 'has polls');
  console.log(`  ✓ LimitBot connected · pollCount=${state.limit.pollCount} · lastError=${state.limit.lastError || 'none'}`);

  // 4. SniperBot on dashboard
  assert.ok(state.sniper && state.sniper.capital === 150, 'SniperBot present, $150');
  console.log(`  ✓ SniperBot present · $${state.sniper.capital} · connected=${state.sniper.connected}`);

  console.log('\n✅ Dashboard smoke test passed');
  server.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error('DASHBOARD SMOKE FAIL:', e.message); try { server && server.kill('SIGKILL'); } catch(_){} process.exit(1); });
