const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const test=require("node:test");
const config=require("./btc/config.js");
const Bot=require("./btc/wick-bot.js");
const{takeProfitHit}=Bot._test;

function makeBot(){
  const start=1800000;
  const bot=new Bot({timeframe:"5m",windowMs:config.WINDOW_MS_5M,priceFeed:{
    getTicks:()=>[],getMinuteCandles:()=>[],getHistoricalCandles:()=>[],
    snapshot:()=>({status:"test"}),start(){},stop(){}
  }});
  bot.market={id:"market",slug:"btc-updown-5m-test",title:"BTC up or down",start,
    tokens:{UP:"up-token",DOWN:"down-token"},feesEnabled:false};
  bot.openStrategyWindow(start,start);
  return{bot,start};
}
function quote(bot,side,ask,bid,at){
  bot.liveQuotes[side]={status:"LIVE",bestAsk:ask,askSize:500,bestBid:bid,bidSize:500,
    mid:(ask+bid)/2,updatedAt:at};
}
function observe(bot,start,at,{upAsk,downAsk,upBid,downBid}={}){
  if(upAsk!=null)quote(bot,"UP",upAsk,upBid??upAsk-.01,at);
  if(downAsk!=null)quote(bot,"DOWN",downAsk,downBid??downAsk-.01,at);
  bot.processClimbEntries(start,at);
}

test("config defines 38 one-cent rungs, 20 shares, and 80-cent TP",()=>{
  assert.equal(config.ENTRY_MIN_PRICE,.03);
  assert.equal(config.ENTRY_MAX_PRICE,.40);
  assert.equal(config.ENTRY_STEP_PRICE,.01);
  assert.equal(config.ENTRY_SHARES,20);
  assert.equal(config.TAKE_PROFIT_PRICE,.80);
});
test("places all 76 one-time limit orders at window start on both sides",()=>{
  const{bot,start}=makeBot();
  assert.equal(bot.windowOrders.length,76);
  assert.equal(bot.windowOrders.filter(x=>x.side==="UP").length,38);
  assert.equal(bot.windowOrders.filter(x=>x.side==="DOWN").length,38);
  assert.equal(bot.windowOrders[0].status,"PENDING");
  assert.equal(bot.windowOrders[0].orderType,"LIMIT");
  assert.deepEqual(bot.windowOrders.filter(x=>x.side==="UP").map(x=>x.limitPrice).sort((a,b)=>a-b),
    Array.from({length:38},(_,i)=>Number((.03+i*.01).toFixed(2))));
  assert.ok(bot.windowOrders.every(x=>x.windowStart===start&&x.shares===20));
});
test("resting orders fill at their rung when own-side ask crosses down",()=>{
  const{bot,start}=makeBot();
  observe(bot,start,start+7000,{upAsk:.39,downAsk:.41});
  assert.deepEqual(bot.positions.filter(p=>p.side==="UP").map(p=>p.rungPrice).sort((a,b)=>a-b),[.39,.40]);
  assert.equal(bot.positions.every(p=>p.shares===20&&p.avgEntry===p.rungPrice),true);
  assert.equal(bot.positions.some(p=>p.side==="DOWN"),false);
  const count=bot.positions.length;
  observe(bot,start,start+8000,{upAsk:.39,downAsk:.41});
  assert.equal(bot.positions.length,count);
});
test("both sides can fill independently and waits beyond the opening seconds",()=>{
  const{bot,start}=makeBot();
  observe(bot,start,start+60000,{upAsk:.30,downAsk:.20});
  assert.equal(bot.positions.filter(p=>p.side==="UP").length,11);
  assert.equal(bot.positions.filter(p=>p.side==="DOWN").length,21);
});
test("does not fill if ask is above rung or quote is stale",()=>{
  const{bot,start}=makeBot();
  observe(bot,start,start+100,{upAsk:.41,downAsk:.41});
  assert.equal(bot.positions.length,0);
  quote(bot,"UP",.20,.19,start-1);
  bot.processClimbEntries(start,start+100);
  assert.equal(bot.positions.length,0);
});
test("TP triggers at 80 cents and credits exactly 80 cents per share",()=>{
  const{bot,start}=makeBot();
  const pos={id:"p",status:"OPEN",side:"UP",shares:20,totalCost:8,windowStart:start};
  bot.positions=[pos];
  assert.equal(takeProfitHit({bestBid:.79,updatedAt:start+100},start+100),false);
  assert.equal(takeProfitHit({bestBid:.80,updatedAt:start+100},start+100),true);
  quote(bot,"UP",.81,.80,start+100);
  bot.processTakeProfitExits(start+100);
  assert.equal(pos.status,"SETTLED_EXIT");
  assert.equal(pos.payout,.80);
  assert.equal(pos.proceeds,16);
  assert.equal(pos.realizedPnl,8);
});
test("TP cancels remaining same-side orders and prevents that side re-entry",()=>{
  const{bot,start}=makeBot();
  const pos={id:"p",status:"OPEN",side:"UP",shares:20,totalCost:8,windowStart:start};
  bot.positions=[pos];
  quote(bot,"UP",.81,.80,start+100);
  bot.processTakeProfitExits(start+100);
  assert.equal(bot.windowOrders.filter(o=>o.side==="UP"&&o.status==="PENDING").length,0);
  assert.equal(bot.windowOrders.filter(o=>o.side==="UP"&&o.status==="CANCELLED_NO_REENTRY").length,38);
  assert.equal(bot.windowOrders.filter(o=>o.side==="DOWN"&&o.status==="PENDING").length,38);
  observe(bot,start,start+200,{upAsk:.03,downAsk:.03});
  assert.equal(bot.positions.some(p=>p.side==="UP"&&p.id!=="p"),false);
  assert.equal(bot.positions.some(p=>p.side==="DOWN"),true);
});
test("API snapshot describes pending and filled two-sided rungs",()=>{
  const{bot,start}=makeBot();
  observe(bot,start,start+100,{upAsk:.40,downAsk:.41});
  const s=bot.snapshot(),entries=s.strategy.entries;
  assert.equal(entries.orderType,"LIMIT");
  assert.equal(entries.sharesPerEntry,20);
  assert.equal(entries.takeProfitPrice,.80);
  assert.equal(entries.rungs.length,38);
  assert.equal(entries.sideLadders.UP.triggeredRungs.length,1);
  assert.equal(entries.sideLadders.UP.pendingOrders,37);
  assert.equal(entries.sideLadders.DOWN.pendingOrders,38);
});
test("dashboard presents limit ladder, take-profit, and paper-only behavior",()=>{
  const h=fs.readFileSync(path.join(__dirname,"../../public/btc.html"),"utf8");
  assert.match(h,/PAPER ONLY · NO LIVE ORDERS/);
  assert.ok(h.includes("20 shares per rung"));
  assert.ok(h.includes("40¢ to 3¢ by 1¢"));
  assert.ok(h.includes("80¢ per share"));
  assert.ok(h.includes("refresh();setInterval(refresh,1000)"));
});
    