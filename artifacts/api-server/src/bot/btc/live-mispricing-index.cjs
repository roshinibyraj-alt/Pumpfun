'use strict';

const { Pool } = require('pg');
const LivePolymarketTrader = require('./live-polymarket-trader.cjs');
const { LiveCrossPairBot, LIVE_BOT_KEY } = require('./live-cross-pair-bot.cjs');
const { LiveMispricingStateStore } = require('./live-mispricing-state-store.cjs');
const { createLiveMispricingServer } = require('./live-mispricing-server.cjs');
const marketData = require('./wick-market-data.js');

function classifyAuthError(value) {
  const message = String(value || '').toLowerCase();
  if (!message) return 'NONE';
  if (/geo.?block|restricted (?:location|region|country|jurisdiction)|not available in (?:your )?(?:region|location)/i.test(message)) {
    return 'LOCATION_RESTRICTION';
  }
  if (/private key|invalid (?:hex|signer|key)|malformed key|expected .*bytes/i.test(message)) {
    return 'SIGNER_OR_KEY_FORMAT';
  }
  if (/did not resolve the account wallet|wallet.*not resolve/i.test(message)) {
    return 'WALLET_NOT_RESOLVED';
  }
  if (/unauthorized|forbidden|\b401\b|\b403\b|signature|api key/i.test(message)) {
    return 'AUTH_REJECTED';
  }
  if (/timeout|network|fetch failed|econn|enotfound/i.test(message)) {
    return 'NETWORK_ERROR';
  }
  if (/module not found|package path|err_module|not exported/i.test(message)) {
    return 'SDK_LOAD_ERROR';
  }
  return 'OTHER_AUTH_ERROR';
}

function classifyHaltReason(value) {
  const reason = String(value || '').toLowerCase();
  if (!reason) return 'NONE';
  if (reason.includes('authentication failed')) return 'AUTHENTICATION_FAILED';
  if (reason.includes('ledger could not be saved')) return 'LEDGER_SAVE_FAILED';
  if (reason.includes('no exchange order id')) return 'ORDER_ID_MISSING';
  if (reason.includes('could not be reconciled')) return 'ORDER_RECONCILIATION_FAILED';
  if (reason.includes('could not be confirmed canceled')) return 'CANCEL_UNCONFIRMED';
  if (reason.includes('matched quantity')) return 'FILL_QUANTITY_MISSING';
  if (reason.includes('invalid size or limit price')) return 'INVALID_ORDER_PARAMETERS';
  if (reason.includes('submission outcome is uncertain')) return 'SUBMISSION_UNCERTAIN';
  if (reason.includes('account adapter is not configured')) return 'TRADER_UNAVAILABLE';
  return 'OTHER_HALT';
}

function safeLogTag(value) {
  const tag = String(value || '');
  return /^[A-Z][A-Za-z0-9_]{0,63}$/.test(tag) ? tag : 'OTHER';
}

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
  const store = new LiveMispricingStateStore(pool, {
    botKey: LIVE_BOT_KEY,
  });
  const bot = new LiveCrossPairBot({
    stateStore: store,
    trader,
    tradingEnabled,
    marketData,
    auditLogger: record => console.log(`LIVE_AUDIT ${JSON.stringify(record)}`),
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
    const collateral = state.account?.collateral;
    const collateralAvailable = collateral != null && Number.isFinite(Number(collateral));
    const uncertainStatuses = new Set([
      'SUBMITTING', 'SUBMISSION_UNCERTAIN', 'CANCEL_UNCERTAIN', 'RECONCILIATION_REQUIRED',
    ]);
    const unresolvedOrderCount = Number.isFinite(Number(state.haltRecovery?.unresolvedOrderCount))
      ? Number(state.haltRecovery.unresolvedOrderCount)
      : Array.isArray(state.liveOrders)
        ? state.liveOrders.filter(order => uncertainStatuses.has(order.status)).length
        : 0;
    console.log(`BTC/ETH live mixed-pair bot status: ${state.status}`);
    console.log(
      `Polymarket account auth=${Boolean(state.account?.authenticated)} `
      + `keyConfigured=${Boolean(privateKey)} `
      + `accountStatus=${String(state.account?.status || 'UNKNOWN')} `
      + `authErrorClass=${classifyAuthError(state.account?.error)} `
      + `authErrorName=${safeLogTag(state.account?.errorName || 'NONE')} `
      + `authErrorCode=${safeLogTag(state.account?.errorCode || 'NONE')} `
      + `accountReady=${Boolean(state.account?.accountReady)} `
      + `ordersSnapshot=${safeLogTag(state.account?.orderSnapshotStatus || 'UNKNOWN')} `
      + `positionsStatus=${safeLogTag(state.account?.positionsStatus || 'UNKNOWN')} `
      + `positionsHttpStatus=${Number.isFinite(Number(state.account?.positionsHttpStatus)) ? Number(state.account.positionsHttpStatus) : 'NONE'} `
      + `positionsRetryAfterMs=${Number.isFinite(Number(state.account?.positionsRetryAfterMs)) ? Number(state.account.positionsRetryAfterMs) : 'NONE'} `
      + `balanceStatus=${safeLogTag(state.account?.balanceStatus || 'UNKNOWN')} `
      + `collateralSnapshot=${collateralAvailable} `
      + `ordersEnabled=${Boolean(state.tradingEnabled && state.account?.accountReady)} `
      + `unresolvedOrders=${unresolvedOrderCount} `
      + `exchangeOpenOrders=${Array.isArray(state.account?.orders) ? state.account.orders.length : 'UNKNOWN'} `
      + `persistence=${String(state.persistence?.status || 'UNKNOWN')}`,
    );
  } catch (error) {
    console.error(`BTC/ETH live mixed-pair startup failed: ${String(error?.message || error).slice(0, 240)}`);
  }

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Stopping BTC/ETH live mixed-pair service (${signal}).`);
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
