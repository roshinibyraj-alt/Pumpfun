'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const Bot = require('../freqai-martingale-btc-bot');
const sizing = require('../martingale-sizing');
const { planTakerBuy, planRecoveryBuy } = require('../taker-fill');
const { restoreOrResetLedger } = require('../index');
const W = 300000, START = 1800000000000;
function fixture(capital = 3000) {
  let now, raw, reply;
  const bot = new Bot({ initialCapital: capital, now: () => now, marketData: {}, paperExecutionDelayMs: 0,
    freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: raw }) },
    getOrderBook: async () => reply });
  const r = bot.records.get('BTC:5m');
  function quote(bid=.59, ask=.6) {
    for (const side of ['UP','DOWN']) r.quotes[side] = { bestBid:bid,bestAsk:ask,
      mid:bid==null||ask==null?null:(bid+ask)/2, updatedAt:now,
      tokenId:r.market.tokens[side],marketId:r.market.id,windowStart:r.market.start,
      asks:ask==null?[]:[{price:ask,size:100000}],bids:bid==null?[]:[{price:bid,size:100000}] };
  }
  function open(n) {
    now=START+n*W+60000; r.marketStatus='OPEN';
    r.market={id:`m${n}`,start:START+n*W,end:START+(n+1)*W,
      tokens:{UP:`up${n}`,DOWN:`down${n}`},feeSchedule:{rate:.05}};
    raw={windowStart:r.market.start,candleStart:r.market.start,candleCloseAt:now,writtenAt:now,pUp:.7,pDown:.3};
    quote();
  }
  open(0);
  return {bot,r,open,quote,now:()=>now,time:t=>{now=t;},score:p=>{raw.pUp=p;raw.pDown=1-p;raw.candleCloseAt=now;raw.writtenAt=now;},
    reply:b=>{reply=b;},buy:()=>{bot.processSide(r,'UP',r.quotes.UP,1);return bot.shadowEntries[0];},
    end:(outcome='LOSS')=>{now=r.market.end; if(outcome==='LOSS')quote(0,.01);
      else if(outcome==='WIN')quote(.99,1);else quote(.49,.51);bot.expireMarket(r,now);
      if(outcome==='LOSS')bot.settleMarket(r.market.id,'DOWN',now);} };
}
test('50 base, next-window recovery covers cost and fees plus $10, then reset',()=>{
  const f=fixture(),base=f.buy();assert.equal(base.requestedShares,50);
  f.end();assert.ok(Math.abs(f.bot.recovery.netPnl+30.6)<1e-8);
  f.open(1);const recovery=f.buy();assert.equal(recovery.recoveryRole,'RECOVERY');
  assert.equal(recovery.requestedShares,105);
  assert.ok(recovery.shares-recovery.totalCost-recovery.fees>=40.6);
  f.end('WIN');assert.equal(f.bot.recovery.active,false);
  f.open(2);assert.equal(f.buy().requestedShares,50);
});
test('repeated losses accumulate actual fee-inclusive losses, not fixed doubling',()=>{
  const f=fixture();f.buy();f.end();f.open(1);const e=f.buy();f.end();
  assert.ok(Math.abs(f.bot.recovery.netPnl-(-30.6-e.totalCost-e.fees))<1e-8);
  f.open(2);f.quote(.39,.4);const next=f.buy();
  assert.equal(next.requestedShares,179);
  assert.ok(next.shares-next.totalCost-next.fees>=-f.bot.recovery.netPnl+10);
});
test('base wins stay 50; unclear outcomes keep base trading; late losses remain recoverable',()=>{
  const f=fixture();f.buy();f.end('WIN');f.open(1);const e=f.buy();assert.equal(e.shares,50);
  f.end('UNKNOWN');f.open(2);assert.equal(f.buy().shares,50);
  f.bot.decide(e,'LOSS','OFFICIAL_SETTLEMENT',f.now());
  assert.equal(f.bot.recovery.active,true);
});
test('unclear recovery waits while base outcomes contribute to the same cycle',()=>{
  const f=fixture();f.buy();f.end();f.open(1);const e=f.buy();f.end('UNKNOWN');
  f.open(2);const base=f.buy();assert.equal(base.requestedShares,50);assert.equal(base.recoveryRole,'BASE');
  assert.equal(f.bot.snapshot().recovery.phase,'WAITING_RESULT');
  const before=f.bot.recovery.netPnl;f.end('WIN');
  assert.ok(f.bot.recovery.netPnl>before);assert.equal(f.bot.recovery.active,true);
  f.bot.decide(e,'LOSS','MARK',f.now());assert.equal(f.bot.recovery.awaitingEntryId,null);
});
test('depth-aware minimum sizing accounts for multiple price levels and fees',()=>{
  const f=fixture();f.r.quotes.UP.asks=[{price:.4,size:20},{price:.7,size:1000}];
  const fill=planRecoveryBuy(f.r,'UP',f.now(),3000,50);
  assert.ok(fill.shares-fill.totalCost-fill.fees>=50);
  const less=planTakerBuy(f.r,'UP',f.now(),3000,fill.shares-1);
  assert.ok(less.shares-less.totalCost-less.fees<50);
  f.r.market.feesEnabled=false;
  const free=planRecoveryBuy(f.r,'UP',f.now(),3000,50);
  assert.equal(free.fees,0);assert.ok(free.shares<=fill.shares);
});
test('insufficient cash or depth skips recovery rather than claiming target or partial fill',()=>{
  const f=fixture(60);f.buy();f.end();f.open(1);f.buy();
  assert.equal(f.bot.shadowEntries.length,1);assert.match(f.bot.statusReason,/insufficient/);
  const g=fixture();g.buy();g.end();g.open(1);g.r.quotes.UP.asks=[{price:.6,size:30}];g.buy();
  assert.equal(g.bot.shadowEntries.length,1);
  const h=fixture();h.r.quotes.UP.asks=[{price:.6,size:20}];
  assert.equal(h.buy().shares,20);assert.equal(h.bot.shadowEntries[0].cancelledShares,30);
});
test('official loss pays once, and a later conflicting result cannot size it twice',()=>{
  const f=fixture(),e=f.buy();f.end();const saved=structuredClone(f.bot.recovery);
  assert.ok(Math.abs(f.bot.shadowTotals[58].realizedPnl+30.6)<1e-8);
  f.bot.settleMarket('m0','UP',f.now());f.bot.settleMarket('m0','UP',f.now()+1);
  assert.deepEqual(f.bot.recovery,saved);assert.equal(e.modeledPayout,false);
  assert.ok(Math.abs(e.realizedPnl+30.6)<1e-8);
  assert.equal(f.bot.shadowTotals[58].resolved,1);
});
test('exact best-bid boundaries and quote guards prevent invented outcomes',()=>{
  for(const x of [null,undefined,NaN,.010001,.02,.98,.5,-1,2])assert.equal(sizing.outcomeForBid(x),null);
  for(const x of [0,.001,.009,.01])assert.equal(sizing.outcomeForBid(x),'LOSS');
  assert.equal(sizing.outcomeForBid(.99),'WIN');
  for(const kind of ['missing','crossed','stale','token','market','window']){
    const f=fixture(),e=f.buy();f.time(f.r.market.end);f.quote(0,.01);
    const q=f.r.quotes.UP;
    if(kind==='missing')q.bestBid=null;if(kind==='crossed')q.bestBid=.9;
    if(kind==='stale')q.updatedAt-=5001;if(kind==='token')q.tokenId='other';
    if(kind==='market')q.marketId='other';if(kind==='window')q.windowStart-=W;
    f.bot.expireMarket(f.r,f.now());assert.equal(e.sizingOutcome,undefined,kind);
  }
});
test('restart preserves dynamic recovery, ledger, cash and consumed window',()=>{
  const f=fixture();f.buy();f.end();f.open(1);f.buy();
  const ledger=JSON.parse(JSON.stringify(f.bot.exportLedger()));
  const g=fixture();g.open(1);g.bot.restoreLedger(ledger);g.buy();
  assert.deepEqual(g.bot.recovery,f.bot.recovery);assert.equal(g.bot.shadowEntries.length,2);
  assert.equal(g.bot.availablePaperCash(),f.bot.availablePaperCash());
  ledger.snapshot.recovery.netPnl=NaN;assert.throws(()=>fixture().bot.restoreLedger(ledger),/Invalid saved recovery/);
});
test('signal threshold, minimum delay and no signal selling stay intact',()=>{
  const f=fixture();f.time(START+44999);f.quote();f.buy();assert.equal(f.bot.shadowEntries.length,0);
  f.time(START+45000);f.quote();f.score(.58);f.buy();assert.equal(f.bot.shadowEntries.length,0);
  f.score(.7);const e=f.buy();f.score(.01);f.buy();f.bot.checkTakeProfits();f.bot.checkStopLosses();
  assert.equal(f.bot.shadowEntries.length,1);assert.equal(e.status,'OPEN');
});
test('strategy ID archives and resets old ledger once, current ledger restores',async()=>{
  const f=fixture();let archived=0;f.bot.ledgerStore={archive:async()=>{archived++;}};
  f.bot.flushLedger=async()=>{};
  assert.equal(await restoreOrResetLedger(f.bot,{strategyId:'old-martingale'},Bot.STRATEGY.id),'reset');
  assert.equal(f.bot.availablePaperCash(),3000);assert.equal(f.bot.recovery.active,false);
  assert.equal(await restoreOrResetLedger(f.bot,f.bot.exportLedger(),Bot.STRATEGY.id),'restored');
  assert.equal(archived,1);
});
test('WebSocket production execution uses dynamically sized recovery',()=>{
  const f=fixture();f.buy();f.end();f.open(1);f.bot.tokenRefs.set('up1',{recordKey:'BTC:5m',side:'UP'});
  f.bot.handleMarketMessage({event_type:'book',asset_id:'up1',timestamp:String(f.now()),
    bids:[{price:'.59',size:'1000'}],asks:[{price:'.6',size:'1000'}]});
  assert.equal(f.bot.shadowEntries[0].requestedShares,105);
});
test('dashboard renders target and size and keeps equity on top',async()=>{
  const f=fixture();f.buy();f.end();f.open(1);
  const html=fs.readFileSync(path.join(__dirname,'../public/freqai-dashboard.html'),'utf8');
  const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1], elements=new Map();
  const element=()=>({textContent:'',innerHTML:'',style:{},dataset:{},addEventListener(){},setAttribute(){},
    classList:{add(){},remove(){}},querySelectorAll(){return[];},querySelector(){return{};}});
  vm.runInNewContext(script,{document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    addEventListener(){},visibilityState:'visible'},fetch:async()=>({ok:true,json:async()=>f.bot.snapshot()}),
    setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},AbortController,Date,Intl,console,
    navigator:{onLine:true},window:{addEventListener(){}}});
  await new Promise(r=>setImmediate(r));
  assert.equal(elements.get('currentShares').textContent,'Priced on signal');
  assert.match(elements.get('recoveryState').textContent,/outstanding loss \$30.60/);
  assert.match(elements.get('recoveryDetails').textContent,/\$40.60/);
  assert.match(elements.get('shadowEntries').innerHTML,/RESOLVED · NET LOSS/);
  assert.match(elements.get('shadowEntries').innerHTML,/Resolution payout \$0\.000/);
  assert.match(elements.get('entryRule').textContent,/modeled \$1\/share/);
  assert.ok(html.indexOf('id="equityChart"')<html.indexOf('<h2>Current BTC window</h2>'));
});
test('HTTP state exposes base 50 and recovery target',async t=>{
  const f=fixture();const server=require('../server')(f.bot,0);
  await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const state=await(await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).json();
  assert.equal(state.sizingByAsset.BTC.baseShares,50);assert.equal(state.recovery.profitTarget,10);
});
