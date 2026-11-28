'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const Engine = require('../shadow-ladder/engine'), Runtime = require('../shadow-ladder/runtime');
const START = 1800000000000, W = 300000;
const near = (a, b) => assert.ok(Math.abs(a - b) < .00001, `${a} != ${b}`);
const fee = (n,p) => Number((n * .05 * p * (1-p)).toFixed(5));
function fixture(engine) {
  let now = START + 1000;
  const e = engine || new Engine({ now: () => now });
  e.now = () => now;
  const record = { marketStatus: 'OPEN', market: { id: 'm', title: 'BTC 5m', start: START, end: START + W,
    tokens: { UP: 'u', DOWN: 'd' }, feeSchedule: { rate: .05, exponent: 1 } }, quotes: {} };
  function quote(side = 'UP', bid = .49, ask = .5, size = 500, overrides = {}) {
    record.quotes[side] = { tokenId: side === 'UP' ? 'u' : 'd', marketId: record.market.id,
      windowStart: record.market.start, updatedAt: now, bestBid: bid, bestAsk: ask,
      asks: [{ price: ask, size }], bids: [{ price: bid, size }], ...overrides };
    e.observe(record, side); return e.positions[0];
  }
  function virtual(side='UP') { quote(side); now += 400; quote(side,.32,.33); }
  function enter(side='UP') { virtual(side); now+=400;quote(side,.7,.71);now+=400;return quote(side,.7,.71); }
  return { e, record, quote, virtual, enter, now: () => now,
    advance(n=400) {now+=n;}, time(n) {now=n;} };
}
test('$0.33 is virtual only: zero orders, shares, spending, fees, reservations or profit', () => {
  const f = fixture(); f.virtual();
  assert.equal(f.e.orders.length,0);assert.equal(f.e.positions.length,0);
  near(f.e.cash,3000);near(f.e.reservedCash(),0);near(f.e.account().realizedPnl,0);
  const tracking=f.e.snapshot().market.tracking;
  assert.equal(tracking.selectedSide,'UP');assert.equal(tracking.entry.state,'WAITING');
});
test('virtual touch requires a later fresh quote; first side stays selected, opposite cannot buy', () => {
  const f=fixture();f.quote('DOWN',.32,.33);assert.equal(f.e.snapshot().market.tracking.selectedSide,null);
  f.advance();f.quote('DOWN',.32,.33);f.advance();f.quote('UP',.32,.33);
  assert.equal(f.e.snapshot().market.tracking.selectedSide,'DOWN');
  f.advance();f.quote('UP',.7,.71);assert.equal(f.e.orders.length,0);
  f.advance();f.quote('DOWN',.7,.71);f.advance();const p=f.quote('DOWN',.7,.71);
  assert.equal(p.side,'DOWN');near(p.shares,300);near(p.baseShares,0);
});
test('300-share entry uses later actual asks and fees, not $0.70 or a fictitious $0.33 base', () => {
  const f=fixture();f.virtual();f.advance();f.quote('UP',.699,.71);assert.equal(f.e.orders.length,0);
  f.advance();f.quote('UP',.7,.71);assert.equal(f.e.orders[0].status,'PENDING');near(f.e.reservedCash(),315);
  f.advance(299);f.quote('UP',.7,.71);assert.equal(f.e.positions.length,0);
  f.advance(1);const p=f.quote('UP',.72,.73);
  near(p.shares,300);near(p.totalCost,219);near(p.entryFees,fee(300,.73));
  near(p.entryPrice,.73);near(p.baseCost,0);near(f.e.cash,3000-219-fee(300,.73));
  assert.equal(f.e.orders[0].type,'TAKER_ENTRY');near(f.e.reservedCash(),0);
});
test('entry sweeps multiple price levels, caps at 300 and never retries an unfilled remainder', () => {
  const f=fixture();f.virtual();f.advance();f.quote('UP',.7,.71);f.advance();
  const p=f.quote('UP',.7,.71,10,{asks:[{price:.71,size:10},{price:.72,size:5}]});
  near(p.shares,15);near(p.totalCost,10.7);assert.equal(f.e.orders[0].status,'PARTIAL');
  f.advance();f.quote('UP',.7,.71);near(p.shares,15);assert.equal(f.e.orders.length,1);
});
test('deep multi-level liquidity still buys no more than 300 shares', () => {
  const f=fixture();f.virtual();f.advance();f.quote('UP',.7,.71);f.advance();
  const p=f.quote('UP',.7,.71,100,{asks:[{price:.71,size:100},{price:.72,size:1000}]});
  near(p.shares,300);near(p.totalCost,215);
});
test('entries are cash constrained including fees; no debt or imaginary profit budget', () => {
  const f=fixture();f.e.cash=50;const p=f.enter();
  assert.ok(p.shares>0&&p.shares<300);assert.ok(f.e.cash>=0);
  assert.ok(p.totalCost+p.entryFees<=50);near(f.e.reservedCash(),0);
});
test('unknown fees or empty asks cannot invent a filled entry', () => {
  const f=fixture();f.virtual();delete f.record.market.feeSchedule;
  f.advance();f.quote('UP',.7,.71);assert.equal(f.e.orders.length,0);
  f.record.market.feeSchedule={rate:.05,exponent:1};f.advance();f.quote('UP',.7,.71);
  f.advance();f.quote('UP',.7,.71,0);
  assert.equal(f.e.positions.length,0);assert.equal(f.e.orders[0].status,'SKIPPED');
  near(f.e.cash,3000);near(f.e.reservedCash(),0);
});
test('cutoff excludes all entries from exactly the final 120 seconds', () => {
  for(const elapsed of [180000,200000,270000]) {
    const f=fixture();f.virtual();f.time(START+elapsed);f.quote('UP',.7,.71);f.advance();f.quote('UP',.7,.71);
    assert.equal(f.e.positions.length,0);assert.equal(f.e.orders.length,0);
    assert.equal(f.e.snapshot().market.tracking.entry.state,'CUTOFF');
  }
});
test('a delayed entry cannot cross the cutoff; timer cancels it and releases reserved cash', () => {
  const f=fixture();f.virtual();f.time(START+179900);f.quote('UP',.7,.71);
  assert.equal(f.e.orders[0].status,'PENDING');
  f.time(START+180000);f.e.tick();
  assert.equal(f.e.orders[0].status,'CANCELLED');near(f.e.reservedCash(),0);
  f.advance();f.quote('UP',.7,.71);assert.equal(f.e.positions.length,0);near(f.e.cash,3000);
});
test('an entry that completes strictly before cutoff is allowed', () => {
  const f=fixture();f.virtual();f.time(START+179600);f.quote('UP',.7,.71);
  f.advance(399);const p=f.quote('UP',.7,.71);near(p.shares,300);
});
test('SL triggers at exactly bid $0.40, executes after latency at actual bid depth and fees', () => {
  const f=fixture(),p=f.enter();f.advance();f.quote('UP',.401,.41);assert.equal(p.exitPending,null);
  f.advance();f.quote('UP',.4,.41);assert.equal(p.exitPending.reason,'STOP_LOSS');
  near(p.remainingShares,300);f.advance(299);f.quote('UP',.35,.36);near(p.remainingShares,300);
  f.advance(1);f.quote('UP',.35,.36,100,{bids:[{price:.35,size:100},{price:.34,size:200}]});
  assert.equal(p.status,'CLOSED_SL');near(p.exitProceeds,103);near(p.exitFees,fee(100,.35)+fee(200,.34));
  near(p.exitPrice,103/300);near(f.e.cash,3000+p.realizedPnl);
  assert.ok(p.realizedPnl<0);assert.equal(p.exitReason,'STOP_LOSS');
});
test('empty bid depth leaves SL pending; later liquidity works, unchanged consumed depth cannot be reused', () => {
  const f=fixture(),p=f.enter();f.advance();f.quote('UP',.4,.41);
  f.advance();f.quote('UP',.39,.4,0);near(p.remainingShares,300);
  f.advance();f.quote('UP',.39,.4,100);near(p.remainingShares,200);
  f.advance();f.quote('UP',.39,.4,100);near(p.remainingShares,200);
  f.advance();f.quote('UP',.39,.4,200);near(p.remainingShares,100);
  f.advance();f.quote('UP',.39,.4,300);assert.equal(p.status,'CLOSED_SL');
  near(p.sales.reduce((n,x)=>n+x.shares,0),300);
});
test('final 30-second exit uses CURRENT bid, even after an earlier move above $0.90', () => {
  const f=fixture(),p=f.enter();f.advance();f.quote('UP',.95,.96);
  f.time(START+269999);f.quote('UP',.90,.91);assert.equal(p.exitPending,null);
  f.time(START+270000);f.quote('UP',.90,.91);assert.equal(p.exitPending.reason,'LATE_EXIT');
  f.advance();f.quote('UP',.85,.86);assert.equal(p.status,'CLOSED_LATE');
  near(p.exitProceeds,255);near(p.exitFees,fee(300,.85));near(f.e.cash,3000+p.realizedPnl);
});
test('late bid above $0.90 is held; a later drop during final 30s triggers the sale', () => {
  const f=fixture(),p=f.enter();f.time(START+270000);f.quote('UP',.901,.91);
  assert.equal(p.exitPending,null);f.advance();f.quote('UP',.9,.91);
  assert.equal(p.exitPending.reason,'LATE_EXIT');
});
test('SL remains active after entry cutoff; a latched market exit is not replaced by modeled TP', () => {
  const f=fixture(),p=f.enter();f.time(START+200000);f.quote('UP',.4,.41);
  f.advance();f.quote('UP',.99,.999);
  assert.equal(p.status,'CLOSED_SL');near(p.exitPrice,.99);
  assert.ok(p.sales.every(s=>s.kind==='STOP_LOSS'));
});
test('TP at bid $0.99 credits modeled $1 per purchased share once, without re-entry', () => {
  const f=fixture(),p=f.enter();f.advance();f.quote('UP',.989,.995);assert.equal(p.status,'OPEN');
  f.advance();f.quote('UP',.99,.999);assert.equal(p.status,'CLOSED_TP');
  near(p.exitProceeds,300);near(p.exitPrice,1);near(p.realizedPnl,300-213-fee(300,.71));
  const cash=f.e.cash;f.advance();f.quote('UP',.7,.71);assert.equal(f.e.positions.length,1);
  f.time(START+W);f.e.settle('m','UP');near(f.e.cash,cash);
});
test('partial stop plus official settlement reconciles actual proceeds and all fees', () => {
  const f=fixture(),p=f.enter();f.advance();f.quote('UP',.4,.41);
  f.advance();f.quote('UP',.39,.4,100);near(p.remainingShares,200);
  near(f.e.account().unrealizedPnl,200*.39+39-fee(100,.39)-213-fee(300,.71));
  f.time(START+W);f.e.tick();assert.equal(p.status,'PENDING_RESOLUTION');
  assert.equal(f.e.account().equity,null);f.e.settle('m','UP');
  assert.equal(p.status,'RESOLVED_WIN');near(p.exitProceeds,239);
  near(p.realizedPnl,239-213-fee(300,.71)-fee(100,.39));near(f.e.cash,3000+p.realizedPnl);
});
test('official losing settlement is zero for remaining shares; positions never roll into new windows', () => {
  const f=fixture(),p=f.enter();f.time(START+W);f.e.tick();
  f.quote('UP',.99,.999);assert.equal(p.status,'PENDING_RESOLUTION');
  f.e.settle('m','DOWN');near(p.exitProceeds,0);near(p.realizedPnl,-213-fee(300,.71));
  f.record.market={...f.record.market,id:'next',start:START+W,end:START+2*W};
  f.quote('UP',.7,.71);assert.equal(f.e.positions.length,1);
  assert.equal(f.e.snapshot().market.tracking.selectedSide,null);
});
test('wrong token/window, stale, future, crossed or expired quotes cannot select or buy', () => {
  const f=fixture();f.quote();
  for(const make of [()=>({tokenId:'wrong'}),()=>({marketId:'wrong'}),()=>({windowStart:START-W}),
    ()=>({updatedAt:f.now()-2001}),()=>({updatedAt:f.now()+1}),()=>({bestBid:.4})]) {
    f.advance();f.quote('UP',.32,.33,500,make());assert.equal(f.e.snapshot().market.tracking.selectedSide,null);
  }
  f.time(START+W);f.quote('UP',.32,.33);assert.equal(f.e.positions.length,0);
});
test('restart preserves selection, pending entry and cutoff with no duplicate purchases', () => {
  const f=fixture();f.virtual();f.advance();f.quote('UP',.7,.71);
  const e=new Engine({now:f.now});e.restore(f.e.export());
  const g=fixture(e);g.time(f.now()+400);g.quote('UP',.7,.71);near(e.positions[0].shares,300);
  const saved=e.export(),e2=new Engine({now:g.now});e2.restore(saved);
  const h=fixture(e2);h.time(g.now()+400);h.quote('UP',.7,.71);
  assert.equal(e2.positions.length,1);assert.equal(e2.orders.length,1);near(e2.cash,e.cash);
});
test('restart preserves partial stop consumed depth, cash and fees without selling it twice', () => {
  const f=fixture(),p=f.enter();f.advance();f.quote('UP',.4,.41);
  f.advance();f.quote('UP',.39,.4,100);near(p.remainingShares,200);
  const e=new Engine({now:f.now});e.restore(f.e.export());
  const g=fixture(e);g.time(f.now()+400);g.quote('UP',.39,.4,100);
  near(e.positions[0].remainingShares,200);near(e.cash,f.e.cash);
  g.advance();g.quote('UP',.39,.4,300);assert.equal(e.positions[0].status,'CLOSED_SL');
  near(e.cash,3000+e.positions[0].realizedPnl);
});
test('corrupt saved cash and market-order quantities fail explicitly; no silent resets', () => {
  const f=fixture();f.enter();const bad=f.e.export();bad.cash+=1;
  assert.throws(()=>new Engine().restore(bad),/reconciliation/);
  const qty=f.e.export();qty.orders[0].filledShares+=1;
  assert.throws(()=>new Engine().restore(qty),/quantities/);
});
test('runtime starts a fresh separate ledger, preserves old files/main, then restores the new history', async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'virtual33-reset-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const old=path.join(parent,'old-ledger.json');fs.writeFileSync(old,'old shadow history');
  const main={cash:123,history:[{id:'main-keep'}],applyBook(){},
    marketData:{getMarket:async()=>({}),resolvedWinner:()=>null}};
  const original=main.applyBook,before=JSON.stringify(main),directory=path.join(parent,'new');
  const f=fixture(),r=new Runtime(main,{directory,now:f.now});await r.start();
  near(r.engine.cash,3000);assert.equal(r.engine.positions.length,0);
  f.enter();r.engine=f.e;await r.stop();
  assert.equal(main.applyBook,original);assert.equal(JSON.stringify(main),before);
  assert.equal(fs.readFileSync(old,'utf8'),'old shadow history');
  const r2=new Runtime(main,{directory,now:f.now});await r2.start();
  assert.equal(r2.engine.positions.length,1);near(r2.engine.cash,f.e.cash);await r2.stop();
});
test('runtime resolves expired holdings without changing main and refuses corrupt shadow files', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'virtual33-runtime-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture();f.enter();f.time(START+W);f.e.tick();
  const main={cash:123,applyBook(){},marketData:{getMarket:async()=>({winner:'UP'}),resolvedWinner:m=>m.winner}};
  const r=new Runtime(main,{directory:dir,now:f.now});r.engine=f.e;await r.start();await r.tick();
  assert.equal(r.engine.positions[0].status,'RESOLVED_WIN');assert.equal(main.cash,123);await r.stop();
  fs.writeFileSync(path.join(dir,'ledger.json'),'{broken');
  const r2=new Runtime(main,{directory:dir,now:f.now});await r2.start();
  assert.equal(r2.snapshot().status,'ERROR');await r2.stop();
  assert.equal(fs.readFileSync(path.join(dir,'ledger.json'),'utf8'),'{broken');
});
test('production book-normalization hook drives virtual selection, market buy and actual-depth stop', async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'virtual33-hook-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const f=fixture(),Main=require('../price-resting-btc-bot');
  const main=new Main({now:f.now,marketData:{}});
  const record=main.records.get('BTC:5m');
  record.market=f.record.market;record.marketStatus='OPEN';
  const r=new Runtime(main,{directory,now:f.now});await r.start();
  const book=(bid,ask)=>main.applyBook(record,'UP',{
    bids:[{price:String(bid),size:'500'}],asks:[{price:String(ask),size:'500'}]},f.now());
  book(.49,.5);f.advance();book(.32,.33);
  assert.equal(r.engine.snapshot().market.tracking.selectedSide,'UP');
  assert.equal(r.engine.orders.length,0);
  f.advance();book(.7,.71);f.advance();book(.7,.71);
  near(r.engine.positions[0].shares,300);
  f.advance();book(.4,.41);f.advance();book(.38,.39);
  assert.equal(r.engine.positions[0].status,'CLOSED_SL');
  near(r.engine.positions[0].exitPrice,.38);
  assert.equal(main.shadowEntries.length,0);
  await r.stop();
  assert.match(new Runtime(main).directory,/shadow-virtual33-entry70-stop40-reset-v1$/);
});
test('HTTP/UI expose virtual selection, cutoff, market entry and risk rules with no $0.33 order', async t=>{
  const f=fixture();f.virtual();
  const main=new(require('../price-resting-btc-bot'))({marketData:{}});
  const server=require('../server')(main,0,{snapshot:()=>f.e.snapshot()});
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  const state=await(await fetch(url+'/api/shadow/state')).json();
  assert.equal(state.market.tracking.selectedSide,'UP');assert.equal(state.orders.length,0);
  const html=await(await fetch(url+'/shadow')).text(),nodes=new Map();
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{
    document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',className:'',style:{},before(){}});return nodes.get(id);}},
    fetch:async()=>({ok:true,json:async()=>state}),setTimeout(){},Date,console});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(nodes.get('tracking').innerHTML,/UP selected/);
  assert.match(nodes.get('orders').innerHTML,/never places an order/);
  assert.match(nodes.get('rules').innerHTML,/final 120 seconds/);
  assert.match(nodes.get('rules').innerHTML,/0.400/);
  assert.match(nodes.get('rules').innerHTML,/final 30 seconds/);
  assert.match(nodes.get('cash').innerHTML,/3,000\.00/);
});
