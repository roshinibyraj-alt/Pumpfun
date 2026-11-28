'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Bot = require('../price-resting-btc-bot');
const sizing = require('../price-recovery-sizing');
const {restoreOrResetLedger} = require('../index');
const START = 1800000000000, W = 300000;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function fixture() {
  let now=START+45000, saved;
  const bot=new Bot({now:()=>now,marketData:{},ledgerStore:{save:async l=>{saved=structuredClone(l);}}});
  const r=bot.records.get('BTC:5m');
  const quote=(bid=.84,ask=.85,size=100,side='UP',at=now)=>{
    r.quotes[side]={bestBid:bid,bestAsk:ask,bids:[{price:bid,size}],
      asks:[{price:ask,size:1000}],updatedAt:at,tokenId:r.market.tokens[side],
      marketId:r.market.id,windowStart:r.market.start};
  };
  const open=(n=0)=>{now=START+n*W+45000;r.marketStatus='OPEN';
    r.market={id:`m${n}`,slug:`btc-${n}`,start:START+n*W,end:START+(n+1)*W,
      tokens:{UP:`up${n}`,DOWN:`down${n}`},feeSchedule:{rate:.05}};
    quote();quote(.14,.15,100,'DOWN');};
  open();
  return {bot,r,quote,open,now:()=>now,time:t=>{now=t;},
    step:(n=300)=>{now+=n;},process:()=>bot.processShadowEntries(r),
    saved:()=>saved,
    place:()=>{bot.processShadowEntries(r);return bot.priceRestingOrders[0];},
    fill:(size=100)=>{now+=300;quote(.8,.81,size);bot.processShadowEntries(r);return bot.shadowEntries[0];},
    stop:()=>{now+=300;quote(.6,.61,10000);bot.processShadowEntries(r);
      now+=300;quote(.59,.60,10000);bot.processShadowEntries(r);}};
}
test('waits 45 seconds and ignores probabilities; exact .85 triggers a resting .80 order',()=>{
  const f=fixture();f.time(START+44999);f.quote();f.process();assert.equal(f.bot.priceRestingOrders.length,0);
  f.time(START+45000);f.quote(.83,.8499);f.process();assert.equal(f.bot.priceRestingOrders.length,0);
  f.quote();const o=f.place();assert.equal(o.limitPrice,.8);assert.equal(o.status,'RESTING');
  near(o.requestedShares,6.25);assert.equal(f.bot.initialCapital,1000);
  assert.equal(f.bot.shadowEntries.length,0);near(f.bot.reservedCash(),5);
  const s=f.bot.snapshot();near(s.shadowAccount.availableCash,995);near(s.shadowAccount.equity,1000);
  assert.equal(s.freqai.usedForEntry,false);assert.equal(s.makerRebates.standardTierRate,0);
});
test('DOWN can trigger independently of a missing model and cannot be replaced',()=>{
  const f=fixture();f.quote(.1,.11);f.quote(.85,.86,100,'DOWN');
  const o=f.place();assert.equal(o.side,'DOWN');
  f.step();f.quote(.9,.91);f.quote(.9,.91,100,'DOWN');f.process();
  assert.equal(f.bot.priceRestingOrders.length,1);assert.equal(o.side,'DOWN');
});
test('only a subsequent fresh bid touch fills at exactly .80, with no entry fee',()=>{
  const f=fixture();f.place();f.step();f.quote(.81,.82);f.process();
  assert.equal(f.bot.shadowEntries.length,0);
  f.step();f.quote(.79,.80);f.process();const e=f.bot.shadowEntries[0];
  near(e.shares,6.25);near(e.totalCost,5);near(e.entryPrice,.8);near(e.fees,0);
  near(e.stopLossBid,.6);assert.equal(e.execution,'SIMULATED_MAKER');
  near(f.bot.availablePaperCash(),995);near(f.bot.reservedCash(),0);
});
test('partial maker fills do not recycle unchanged depth; actual replenishment can fill more',()=>{
  const f=fixture(),o=f.place(),e=f.fill(2);
  near(e.shares,2);near(o.remainingShares,4.25);near(f.bot.reservedCash(),3.4);
  for(let i=0;i<4;i++){f.step();f.quote(.8,.81,2);f.process();}
  near(e.shares,2);
  f.step();f.quote(.8,.81,4);f.process();near(e.shares,4);
  f.step();f.quote(.8,.81,10);f.process();near(e.shares,6.25);assert.equal(o.status,'FILLED');
});
test('stale, future, wrong token and crossed books do not place orders',()=>{
  for(const bad of ['stale','future','token','crossed']){
    const f=fixture(),q=f.r.quotes.UP;
    if(bad==='stale')q.updatedAt=f.now()-2001;
    if(bad==='future')q.updatedAt=f.now()+1;
    if(bad==='token')q.tokenId='old-window';
    if(bad==='crossed')q.bestBid=.9;
    f.process();assert.equal(f.bot.priceRestingOrders.length,0,bad);
  }
});
test('SL cancels unfilled maker remainder and sells actual bids after latency with taker fees',()=>{
  const f=fixture(),o=f.place(),e=f.fill(2);f.stop();
  assert.equal(o.status,'CANCELLED_ON_SL');near(o.cancelledShares,4.25);
  assert.equal(e.exitReason,'TAKER_SL');near(e.exitPrice,.59);
  near(e.exitFees,Number((2*.05*.59*.41).toFixed(5)));
  near(e.realizedPnl,2*.59-e.exitFees-1.6);near(f.bot.recovery.netPnl,e.realizedPnl);
  near(f.bot.availablePaperCash(),1000+e.realizedPnl);
  assert.equal(f.bot.priceRestingOrders.length,1);
  f.step();f.quote(.79,.8,100);f.process();assert.equal(f.bot.shadowEntries.length,1);
});
test('recovery freezes original $5 base and targets actual loss plus $2 next window',()=>{
  const f=fixture();f.place();const e=f.fill();f.stop();
  const loss=-e.realizedPnl;
  near(f.bot.recovery.frozenBaseBudget,5);f.open(1);const o=f.place();
  assert.equal(o.recoveryRole,'RECOVERY');near(o.sizing.baseBudget,5);
  assert.ok(o.requestedShares*.2>=loss+2-1e-8);
  assert.ok((o.requestedShares-.01)*.2<loss+2+1e-8);
  f.fill();f.step();f.quote(.99,1);f.process();
  assert.equal(f.bot.recovery.active,false);near(f.bot.recovery.netPnl,0);
  assert.equal(f.bot.shadowTotals[58].resolved,2);
  f.open(2);const next=f.place();near(next.sizing.baseBudget,f.bot.settledCapital()*.005);
});
test('unknown recovery result allows frozen-budget base trading, not concurrent recovery',()=>{
  const s=sizing.newState();Object.assign(s,{active:true,netPnl:-10,frozenBaseBudget:5,awaitingEntryId:'pending'});
  const p=sizing.plan(s,START,800);assert.equal(p.role,'BASE');near(p.baseBudget,5);near(p.requestedShares,6.25);
});
test('TP cancels remainder and pays modeled $1 on held shares only; no re-entry',()=>{
  const f=fixture(),o=f.place(),e=f.fill(2);f.step();f.quote(.99,1);f.process();
  near(e.realizedPnl,.4);near(e.exitPrice,1);assert.equal(e.modeledPayout,true);
  assert.equal(o.status,'CANCELLED_ON_EXIT');near(f.bot.reservedCash(),0);
  f.step();f.quote(.79,.85);f.process();assert.equal(f.bot.priceRestingOrders.length,1);
});
test('expired remainder cannot roll over; official settlement pays only unsold shares',()=>{
  const f=fixture(),o=f.place(),e=f.fill(2);
  f.time(START+W);f.process();assert.equal(o.status,'EXPIRED');near(f.bot.reservedCash(),0);
  f.bot.settleMarket(e.marketId,'UP',f.now());near(e.realizedPnl,.4);
  f.open(1);f.process();assert.equal(f.bot.priceRestingOrders.length,2);
  assert.equal(f.bot.priceRestingOrders[0].filledShares,0);
});
test('cash cannot fund an oversized recovery; no partial undersized target is placed',()=>{
  const f=fixture();Object.assign(f.bot.recovery,{active:true,netPnl:-1000,frozenBaseBudget:5});
  f.process();assert.equal(f.bot.priceRestingOrders.length,0);assert.match(f.bot.statusReason,/insufficient/i);
});
test('restart preserves partial fills, recovery and consumed entry depth',()=>{
  const f=fixture();f.place();f.fill(2);
  const ledger=f.bot.exportLedger(),copy=new Bot({now:f.now,marketData:{}});
  copy.restoreLedger(ledger);near(copy.shadowEntries[0].shares,2);near(copy.reservedCash(),3.4);
  const r=copy.records.get('BTC:5m');Object.assign(r,{market:f.r.market,quotes:f.r.quotes,marketStatus:'OPEN'});
  copy.processShadowEntries(r);near(copy.shadowEntries[0].shares,2);
  const saved=copy.exportLedger();assert.equal(saved.snapshot.priceRestingOrders.length,1);
  assert.equal(saved.snapshot.strategy.id,Bot.STRATEGY.id);
});
test('strategy identity archives old main ledger before starting a fresh $1000 account',async()=>{
  const f=fixture();let archived=false;
  f.bot.ledgerStore.archive=async()=>{archived=true;};
  const result=await restoreOrResetLedger(f.bot,{snapshot:{strategy:{id:'old-main-strategy'}}},Bot.STRATEGY.id);
  assert.equal(result,'reset');assert.equal(archived,true);near(f.bot.initialCapital,1000);
  assert.equal(f.bot.shadowEntries.length,0);
});
test('dashboard renders resting partial fills, capital, recovery, fees and model independence',async()=>{
  const f=fixture();f.place();f.fill(2);
  const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
  const html=fs.readFileSync(path.join(__dirname,'../public/freqai-dashboard.html'),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1],elements=new Map();
  const element=()=>({textContent:'',innerHTML:'',className:'',style:{},dataset:{},addEventListener(){},
    setAttribute(){},classList:{add(){},remove(){}},querySelectorAll(){return[];},querySelector(){return{};}});
  vm.runInNewContext(script,{document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    addEventListener(){},visibilityState:'visible'},fetch:async()=>({ok:true,json:async()=>f.bot.snapshot()}),
    setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},AbortController,Date,Intl,console,
    navigator:{onLine:true},window:{addEventListener(){}}});
  await new Promise(r=>setImmediate(r));
  assert.notEqual(elements.get('status').textContent,'OFFLINE');
  assert.equal(elements.get('currentShares').textContent,'6.25 shares');
  assert.match(elements.get('restingOrders').innerHTML,/2 \/ 6\.25 filled/);
  assert.match(elements.get('restingOrders').innerHTML,/4\.25 resting/);
  assert.match(elements.get('restingOrders').innerHTML,/maker fee \$0/);
  assert.match(elements.get('sizingNote').textContent,/base budget \$5\.00/);
  assert.match(elements.get('reservedCash').textContent,/reserved \$3\.40/);
  assert.match(elements.get('makerRebates').textContent,/credited \$0/);
  assert.match(elements.get('entryRule').textContent,/Fixed SL \$0\.60/);
});
