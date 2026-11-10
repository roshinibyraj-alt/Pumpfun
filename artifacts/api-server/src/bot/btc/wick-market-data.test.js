'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { connectMarketStream } = require('./wick-market-data.js');

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }
}

test('market WebSocket subscribes to both outcome tokens using the CLOB market channel', async () => {
  FakeWebSocket.instances = [];
  let received;
  const statuses = [];
  const stream = connectMarketStream(['up-token', 'down-token', 'up-token'], {
    WebSocketImpl: FakeWebSocket,
    heartbeatMs: 60_000,
    reconnect: false,
    onMessage: message => { received = message; },
    onStatus: update => statuses.push(update.status),
  });

  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://ws-subscriptions-clob.polymarket.com/ws/market');
  socket.readyState = 1;
  socket.emit('open');
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    assets_ids: ['up-token', 'down-token'],
    type: 'market',
    custom_feature_enabled: true,
  });
  socket.emit('message', {
    data: JSON.stringify({ event_type: 'book', asset_id: 'up-token' }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.event_type, 'book');
  assert.deepEqual(statuses.slice(0, 2), ['CONNECTING', 'CONNECTED']);
  stream.close();
});
