'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveMispricingServer } = require('./live-mispricing-server.cjs');

test('real account state is password protected while health status stays minimal', async t => {
  const server = createLiveMispricingServer({
    bot: {
      snapshot: () => ({
        status: 'RUNNING',
        account: { collateral: 123.45, transactions: [{ market: 'BTC' }] },
      }),
    },
    password: 'test-dashboard-password',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;

  const publicState = await fetch(`${url}/api/state`);
  assert.equal(publicState.status, 401);
  assert.equal((await publicState.json()).error, 'Sign in to view account details.');

  const health = await fetch(`${url}/api/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.botStatus, 'RUNNING');
  assert.equal(JSON.stringify(healthBody).includes('123.45'), false);

  const failedLogin = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(failedLogin.status, 401);

  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-dashboard-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const privateState = await fetch(`${url}/api/state`, {
    headers: { Cookie: cookie },
  });
  assert.equal(privateState.status, 200);
  assert.equal((await privateState.json()).account.collateral, 123.45);
});
