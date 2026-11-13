'use strict';

const { Pool } = require('pg');
const LivePolymarketTrader = require('./live-polymarket-trader.cjs');
const { LiveBtcMispricingBot } = require('./live-mispricing-bot.cjs');
const { LiveMispricingStateStore } = require('./live-mispricing-state-store.cjs');
const { createLiveMispricingServer } = require('./live-mispricing-server.cjs');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the isolated live ledger.');
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const privateKey = process.env.PRIVATE_KEY || '';
  const tradingEnabled = String(process.env.LIVE_TRADING || '').toLowerCase() === 'true';
  const trader = privateKey ? new LivePolymarketTrader(privateKey) : null;
  const store = new LiveMispricingStateStore(pool);
  const bot = new LiveBtcMispricingBot({
    stateStore: store,
    trader,
    tradingEnabled,
  });
  const server = createLiveMispricingServer({
    bot,
    password: process.env.TRADING_DASHBOARD_PASSWORD || '',
  });
  const port = Number(process.env.PORT) || 3000;

  server.listen(port, '0.0.0.0', () => {
    console.log(`BTC live mispricing dashboard listening on ${port}`);
  });

  try {
    await bot.start();
    const state = bot.snapshot();
    console.log(`BTC live mispricing bot status: ${state.status}`);
    console.log(
      `Polymarket account auth=${Boolean(state.account?.authenticated)} `
      + `snapshot=${Number.isFinite(Number(state.account?.collateral))} `
      + `ordersEnabled=${Boolean(state.tradingEnabled && !state.liveHalted)}`,
    );
  } catch (error) {
    console.error(`BTC live mispricing startup failed: ${String(error?.message || error).slice(0, 240)}`);
  }

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Stopping BTC live mispricing service (${signal}).`);
    server.close();
    await bot.stop().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch(error => {
  console.error(`BTC live mispricing service could not start: ${String(error?.message || error).slice(0, 240)}`);
  process.exitCode = 1;
});
