'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LivePolymarketTrader = require('./live-polymarket-trader.cjs');

test('account snapshot exposes collateral, marked positions, and recent real trade activity', async () => {
  const trader = new LivePolymarketTrader('test-private-key', {
    sdk: { AssetType: { COLLATERAL: 'COLLATERAL' } },
    actions: {
      async fetchBalanceAllowance() {
        return { balance: '123450000' };
      },
    },
    clock: () => 1_800_000_000_000,
  });
  trader.client = {};
  trader.depositWallet = '0xpublic-wallet';
  trader.getAllPositions = async () => [{
    title: 'BTC Up or Down',
    slug: 'btc-updown-5m-123',
    outcome: 'Up',
    current_size: '10',
    avg_price: '0.42',
    current_price: '0.51',
    current_value: '5.10',
    unrealized_pnl: '0.90',
    token_id: 'public-token-id',
  }];
  trader.listOpenOrders = async () => [{ id: 'public-order-id' }];
  trader.getRecentActivity = async () => [{
    timestamp: 1_799_999_900,
    type: 'TRADE',
    side: 'BUY',
    outcome: 'Up',
    price: '0.42',
    size: '10',
    usdcSize: '4.20',
    title: 'BTC Up or Down',
    slug: 'btc-updown-5m-123',
    transactionHash: '0xpublic-transaction-hash',
    proxyWallet: 'must-not-be-returned',
  }];

  const snapshot = await trader.getEquitySnapshot();
  assert.equal(snapshot.collateral, 123.45);
  assert.equal(snapshot.positionValue, 5.1);
  assert.equal(snapshot.equity, 128.55);
  assert.equal(snapshot.positions[0].shares, 10);
  assert.equal(snapshot.transactions[0].amount, 4.2);
  assert.equal(snapshot.transactions[0].transactionHash, '0xpublic-transaction-hash');
  assert.equal(Object.hasOwn(snapshot.transactions[0], 'proxyWallet'), false);
});

test('taker orders preserve share sizing and post as immediate FAK orders', async () => {
  let created;
  let posted;
  const trader = new LivePolymarketTrader('test-private-key', {
    sdk: {
      OrderSide: { BUY: 'BUY_SIDE', SELL: 'SELL_SIDE' },
      OrderType: { FAK: 'FAK_TYPE' },
    },
  });
  trader.client = {
    async createLimitOrder(request) {
      created = request;
      return { ...request, orderType: 'GTC_TYPE' };
    },
    async postOrder(order) {
      posted = order;
      return { ok: true, orderId: 'taker-order-1', status: 'MATCHED' };
    },
  };

  const response = await trader.placeTakerOrder('token-1', 'BUY', 0.99, 14);

  assert.equal(created.assetId, 'token-1');
  assert.equal(created.side, 'BUY_SIDE');
  assert.equal(created.price, '0.99');
  assert.equal(created.size, '14');
  assert.equal(created.postOnly, false);
  assert.equal(posted.orderType, 'FAK_TYPE');
  assert.equal(posted.postOnly, false);
  assert.equal(response.id, 'taker-order-1');
  assert.equal(response.status, 'MATCHED');
});
