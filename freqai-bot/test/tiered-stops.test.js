'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Bot = require('../freqai-martingale-btc-bot');
const stops = require('../tiered-paper-stops');
const W = 300000, START = 1800000000000;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
function fixture(options = {}) {
  let now = START + 60000, raw, reply;
  const bot = new Bot({ now: () => now, marketData: {}, ...options,
    freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: raw }) },
    getOrderBook: async () => reply });
  const record = bot.records.get('BTC:5m');
  function quote(bids = [{ price: .59, size: 10000 }],
    asks = [{ price: .60, size: 10000 }], side = 'UP', at = now) {
    record.quotes[side] = { bestBid: bids.length ? Math.max(...bids.map(x => x.price)) : null,
      bestAsk: asks.length ? Math.min(...asks.map(x => x.price)) : null,
      updatedAt: at, tokenId: record.market.tokens[side], marketId: record.market.id,
      windowStart: record.market.start, bids, asks };
  }
  function score(up = .8) {
    raw = { windowStart: record.market.start, candleStart: record.market.start,
      candleCloseAt: now, writtenAt: now, pUp: up, pDown: 1 - up };
  }
  function open(n = 0) {
    now = START + n * W + 60000; record.marketStatus = 'OPEN';
    record.market = { id: `m${n}`, start: START + n * W, end: START + (n + 1) * W,
      tokens: { UP: `up${n}`, DOWN: `down${n}` }, feeSchedule: { rate: .05 } };
    quote(); quote(undefined, undefined, 'DOWN'); score();
  }
  function observe() { bot.observeRecordMarks(record, now); }
  open();
  return { bot, record, open, quote, observe, score, now: () => now,
    time: t => { now = t; }, reply: x => { reply = x; },
    buy(ask = .6, side = 'UP', asks = [{ price: ask, size: 10000 }]) {
      score(side === 'UP' ? .8 : .2);
      quote([{ price: Math.max(.001, Math.min(...asks.map(x => x.price)) - .01), size: 10000 }], asks, side);
      bot.processShadowEntries(record);
      now += bot.paperExecutionDelayMs;
      record.quotes[side].updatedAt = now;
      bot.processShadowEntries(record);
      return bot.shadowEntries[0];
    },
    stop(bids = [{ price: .2, size: 10000 }], side = 'UP') {
      now += 1000;
      const bid = Math.max(...bids.map(x => x.price));
      quote(bids, [{ price: Math.min(.999, bid + .01), size: 10000 }], side);
      observe();
      now += bot.paperExecutionDelayMs; observe();
    },
  };
}

test('all exact entry boundaries choose the specified lower tier, including $0.50', () => {
  for (const [entry, stop] of [[.95,.5],[.900001,.5],[.9,.4],[.9000000000000001,.4],
    [.8,.4],[.750001,.4],[.75,.3],[.7,.3],[.650001,.3],[.65,.2],
    [.6,.2],[.500001,.2],[.5,.09],[.4,.09],[.05,.09]]) near(stops.stopFor(entry), stop);
  for (const bad of [null,NaN,0,-1,1,Infinity]) assert.throws(() => stops.stopFor(bad));
});
test('default delayed entry uses the later actual ask sweep and weighted entry tier', () => {
  const f = fixture(), r = f.record;
  f.bot.processShadowEntries(r); assert.equal(f.bot.shadowEntries.length, 0);
  f.time(f.now()+299); f.bot.processShadowEntries(r); assert.equal(f.bot.shadowEntries.length, 0);
  f.time(f.now()+1); f.quote([{price:.87,size:100}], [{price:.88,size:25},{price:.92,size:25}]);
  f.bot.processShadowEntries(r);
  const e=f.bot.shadowEntries[0]; near(e.totalCost,45); near(e.entryPrice,.9);
  near(e.stopLossBid,.4); near(e.fees,.224); assert.equal(e.entryAt-e.entryDecisionAt,300);
});
test('opposite signal during entry latency cancels the old intent and waits again', () => {
  const f=fixture(); f.bot.processShadowEntries(f.record);
  f.time(f.now()+100); f.score(.2); f.bot.processShadowEntries(f.record);
  f.time(f.now()+200); f.bot.processShadowEntries(f.record); assert.equal(f.bot.shadowEntries.length,0);
  f.time(f.now()+100); f.bot.processShadowEntries(f.record);
  assert.equal(f.bot.shadowEntries[0].side,'DOWN');
});
test('entry rejects crossed, future, stale and duplicate-level asks rather than inventing fills', () => {
  for (const kind of ['crossed','future','stale','duplicate']) {
    const f=fixture(); const q=f.record.quotes.UP;
    if(kind==='crossed')q.bestBid=.7;
    if(kind==='future')q.updatedAt=f.now()+1;
    if(kind==='stale')q.updatedAt=f.now()-2001;
    if(kind==='duplicate')q.asks.push({...q.asks[0]});
    f.bot.processShadowEntries(f.record); f.time(f.now()+300); f.bot.processShadowEntries(f.record);
    assert.equal(f.bot.shadowEntries.length,0,kind);
  }
});
test('both sides sell at actual bid depth below the stop, after latency, including exit fees', () => {
  for(const side of ['UP','DOWN']){
    const f=fixture(),e=f.buy(.6,side); f.time(f.now()+1000);
    f.quote([{price:.19,size:10},{price:.1,size:40}],[{price:.21,size:100}],side);
    f.observe(); assert.equal(e.exitShares,0); assert.equal(e.status,'OPEN');
    f.time(f.now()+299);f.observe();assert.equal(e.exitShares,0);
    f.time(f.now()+1);f.observe();
    near(e.exitProceeds,5.9); near(e.exitFees,.25695);
    near(e.exitPrice,.118); near(e.realizedPnl,5.9-.25695-30.6);
    assert.equal(e.exitReason,'TAKER_SL'); assert.equal(e.modeledPayout,false);
    near(f.bot.recovery.netPnl,e.realizedPnl);
    near(f.bot.availablePaperCash(),3000+e.realizedPnl);
    const saved=structuredClone(f.bot.recovery);f.observe();f.bot.settleMarket(e.marketId,'UP',e.windowEnd);
    assert.deepEqual(f.bot.recovery,saved); assert.equal(f.bot.shadowTotals[58].resolved,1);
  }
});
test('every price tier activates at its own stop, not above it', () => {
  for (const [entry,stop] of [[.95,.5],[.8,.4],[.7,.3],[.6,.2],[.5,.09]]) {
    const f=fixture(),e=f.buy(entry);
    f.time(f.now()+1000);f.quote([{price:stop+.001,size:10000}],[{price:stop+.011,size:10000}]);
    f.observe();assert.equal(e.slTriggeredAt,undefined);
    f.stop([{price:stop,size:10000}]);
    near(e.exitPrice,stop);near(e.realizedPnl,50*stop-e.totalCost-e.fees-e.exitFees);
    near(e.exitFees,Number((50*.05*stop*(1-stop)).toFixed(5)));
  }
});
test('production WebSocket entry and stop use post-latency books, not the earlier trigger price', () => {
  const f=fixture();f.bot.tokenRefs.set('up0',{recordKey:'BTC:5m',side:'UP'});
  const ws=(bid,ask)=>f.bot.handleMarketMessage({event_type:'book',asset_id:'up0',
    timestamp:String(f.now()),bids:[{price:String(bid),size:'1000'}],
    asks:[{price:String(ask),size:'1000'}]});
  ws(.59,.6);assert.equal(f.bot.shadowEntries.length,0);
  f.time(f.now()+300);ws(.59,.6);const e=f.bot.shadowEntries[0];assert.ok(e);
  f.time(f.now()+1000);ws(.19,.2);near(e.exitShares,0);
  f.time(f.now()+300);ws(.15,.16);
  near(e.triggerBid,.19);near(e.exitPrice,.15);near(e.exitFees,.31875);
  near(e.realizedPnl,7.5-.31875-30.6);assert.equal(e.exitReason,'TAKER_SL');
});
test('recovery uses the $21 stopped net loss, not the $30.60 entry stake', () => {
  const f=fixture(), e=f.buy();f.stop();
  near(e.realizedPnl,-21);near(e.exitFees,.4);
  near(f.bot.entrySizing(f.record).targetNetProfit,0);
  f.open(1);const recovery=f.buy();
  assert.equal(recovery.recoveryRole,'RECOVERY');assert.equal(recovery.requestedShares,80);
  near(recovery.recoveryTargetNetProfit,31);
  assert.ok(recovery.shares-recovery.totalCost-recovery.fees>=31);
  assert.ok(79*(1-.6-.05*.6*.4)<31);
  f.quote([{price:.99,size:10000}],[{price:.999,size:10000}]);f.observe();
  assert.equal(f.bot.recovery.active,false);
  near(f.bot.shadowTotals[58].realizedPnl,10.04);
  f.open(2);assert.equal(f.buy().requestedShares,50);
});
test('partial SL realizes only filled shares, values remaining shares and cannot reuse unchanged depth', () => {
  const f=fixture(),e=f.buy();
  f.stop([{price:.2,size:10},{price:.18,size:15}]);
  near(e.exitShares,25);near(e.remainingHeldShares,25);
  near(e.exitProceeds,4.7);near(e.exitFees,.1907);
  assert.equal(e.sizingOutcome,undefined); assert.equal(f.bot.shadowTotals[58].resolved,0);
  const account=f.bot.snapshot().shadowAccount;
  near(account.cash,3000-30.6+4.7-.1907);
  near(account.realizedPnl,4.7-.1907-15.3);near(account.unrealizedPnl,5-15.3);
  near(account.equity,account.cash+5);near(account.totalFees,.6+.1907);
  f.observe();near(e.exitShares,25);
  f.time(f.now()+10);f.record.quotes.UP.updatedAt=f.now();f.observe();near(e.exitShares,25);
  f.time(f.now()+10);
  f.quote([{price:.2,size:15},{price:.18,size:15}],[{price:.21,size:100}]);f.observe();
  near(e.exitShares,30,'only the additional five shares replenish depth');
});
test('SL remains latched when prices rebound, and fills the remaining shares at the new bids', () => {
  const f=fixture(),e=f.buy();f.stop([{price:.2,size:10}]);
  f.time(f.now()+100);f.quote([{price:.9,size:40}],[{price:.91,size:100}]);f.observe();
  assert.equal(e.status,'RESOLVED_WIN'); assert.equal(e.exitReason,'TAKER_SL');
  near(e.exitProceeds,38);near(e.exitFees,.26);near(e.realizedPnl,7.14);
  assert.equal(e.sizingOutcome,'WIN');assert.equal(f.bot.recovery.active,false);
});
test('partial SL budget and cash survive restart without re-selling the same book', () => {
  const f=fixture(),e=f.buy();f.stop([{price:.2,size:10}]);
  const saved=JSON.parse(JSON.stringify(f.bot.exportLedger()));
  const g=fixture();g.time(f.now());g.bot.restoreLedger(saved);
  g.quote([{price:.2,size:10}],[{price:.21,size:100}]);g.observe();
  const restored=g.bot.shadowEntries[0];near(restored.exitShares,10);
  near(g.bot.availablePaperCash(),f.bot.availablePaperCash());assert.equal(restored.status,'OPEN');
  g.time(g.now()+1);g.quote([{price:.19,size:40}],[{price:.2,size:100}]);g.observe();
  assert.equal(restored.exitReason,'TAKER_SL');assert.equal(restored.exitShares,50);
  const corrupted=JSON.parse(JSON.stringify(saved));corrupted.snapshot.shadowEntries[0].exitProceeds+=1;
  assert.throws(()=>fixture().bot.restoreLedger(corrupted),/reconcile/);
});
test('remaining shares alone receive official payout; a net loss remains a recovery loss even if the side wins', () => {
  for(const winner of ['UP','DOWN']){
    const f=fixture(),e=f.buy();f.stop([{price:.2,size:25}]);
    f.time(e.windowEnd);f.quote([],[]);f.bot.expireMarket(f.record,f.now());
    f.bot.settleMarket('m0',winner,f.now());
    near(e.terminalPayout,winner==='UP'?25:0);
    near(e.realizedPnl,5-.2+(winner==='UP'?25:0)-30.6);
    near(f.bot.recovery.netPnl,e.realizedPnl);
    assert.equal(e.sizingOutcome,'LOSS');assert.equal(e.resolutionWinner,winner);
    const cash=f.bot.availablePaperCash();f.bot.settleMarket('m0',winner,f.now()+1);
    near(f.bot.availablePaperCash(),cash); assert.equal(f.bot.shadowTotals[58].resolved,1);
    near(f.bot.snapshot().shadowSettledCurve.at(-1).equity,3000+e.realizedPnl);
  }
});
test('no liquidity or zero bids do not invent a sale; expired books cannot fill an SL', async () => {
  const f=fixture(),e=f.buy();f.stop([{price:0,size:1000}]);
  near(e.exitShares,0);near(f.bot.availablePaperCash(),2969.4);
  f.time(e.windowEnd);f.quote([{price:.1,size:1000}],[{price:.11,size:1000}]);
  f.bot.expireMarket(f.record,f.now());near(e.exitShares,0);
  f.reply({asset_id:e.tokenId,timestamp:String(f.now()),bids:[{price:'.01',size:1000}],asks:[]});
  await f.bot.pollUnclearMarks(f.now());assert.equal(e.status,'PENDING_RESOLUTION');
  assert.equal(e.sizingOutcome,undefined);near(e.exitShares,0);
  f.bot.settleMarket('m0','DOWN',f.now());near(e.realizedPnl,-30.6);
});
test('stale, future, crossed and wrong-window stop books cannot release cash', () => {
  for(const kind of ['stale','future','crossed','token','market','window']){
    const f=fixture(),e=f.buy();f.time(f.now()+1000);
    f.quote([{price:.19,size:100}],[{price:.2,size:100}]);const q=f.record.quotes.UP;
    if(kind==='stale')q.updatedAt-=2001;if(kind==='future')q.updatedAt+=1000;
    if(kind==='crossed')q.bestAsk=.1;if(kind==='token')q.tokenId='other';
    if(kind==='market')q.marketId='other';if(kind==='window')q.windowStart-=W;
    f.observe();near(e.exitShares,0,kind);assert.equal(e.sizingOutcome,undefined);
  }
});
test('fee-free markets charge no entry or SL fee and partial base buys keep actual quantities', () => {
  const f=fixture();f.record.market.feesEnabled=false;
  const e=f.buy(.6,'UP',[{price:.6,size:20}]);near(e.shares,20);near(e.fees,0);
  f.stop([{price:.2,size:100}]);near(e.exitShares,20);near(e.exitFees,0);near(e.realizedPnl,-8);
});
test('legacy modeled zero-payout history and recovery are preserved without rewriting closed trades', () => {
  const f=fixture(),e=f.buy();f.time(e.windowEnd);f.quote([],[]);f.bot.expireMarket(f.record,f.now());
  f.bot.settleMarket('m0','DOWN',f.now());
  for(const key of ['exitAccountingVersion','exitShares','exitProceeds','exitFees','slSales',
    'terminalPayout','stopLossBid','remainingHeldShares','partialRealizedPnl'])delete e[key];
  e.exitReason='PAPER_SL';e.modeledPayout=true;e.sizingSource='PAPER_SL';
  f.bot.recovery.lastDecision.source='PAPER_SL';
  const ledger=JSON.parse(JSON.stringify(f.bot.exportLedger())),g=fixture();g.time(f.now());
  g.bot.restoreLedger(ledger);const restored=g.bot.shadowEntries[0];
  assert.equal(restored.modeledPayout,true);assert.equal(restored.exitReason,'PAPER_SL');
  near(restored.realizedPnl,-30.6);assert.deepEqual(g.bot.recovery,f.bot.recovery);
});
