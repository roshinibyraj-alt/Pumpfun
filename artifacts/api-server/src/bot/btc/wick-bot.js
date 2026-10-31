'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');
const {feed:chainlinkFeed}=require('./chainlink-price-feed');
const {classifyRegime}=require('./regime-detector');

function levels(xs){return (xs||[]).map(x=>({price:Number(x.price),size:Number(x.size)}))
  .filter(x=>Number.isFinite(x.price)&&x.size>0).sort((a,b)=>a.price-b.price)}
function usdPrice(x){return '$'+Number(x).toFixed(2)}
function quoteFromBook(book,updatedAt){
  const bids=levels(book.bids),asks=levels(book.asks);
  const bid=bids.sort((a,b)=>b.price-a.price)[0]||null;
  const ask=asks[0]||null;
  const bestBid=bid?.price??null,bestAsk=ask?.price??null;
  return {status:bid||ask?'LIVE':'MISSING',bestBid,bidSize:bid?.size??0,
    bestAsk,askSize:ask?.size??0,mid:bestBid!=null&&bestAsk!=null?(bestBid+bestAsk)/2:null,
    updatedAt,stale:false,error:null};
}
function simulateAtBestAsk(asks,qty,maxPrice,minPrice=cfg.MIN_ENTRY_ASK){
  const best=levels(asks).find(x=>x.price>=minPrice&&x.price<maxPrice);
  if(!best)return null;
  return {shares:qty,cost:qty*best.price,avg:best.price,visibleDepth:best.size,
    simulatedShares:Math.max(0,qty-best.size)};
}
function makerRebateFor(m,price,qty){
  if(m?.feesEnabled===false)return {feeEquivalent:0,estimate:0};
  const rate=Number(m?.feeSchedule?.rate??m?.takerFeeRate??cfg.CRYPTO_TAKER_FEE_RATE);
  const exponent=Number(m?.feeSchedule?.exponent??1);
  const feeEquivalent=Number.isFinite(rate)&&Number.isFinite(exponent)&&price>0&&price<1&&qty>0
    ?rate*Math.pow(price*(1-price),exponent)*qty:0;
  return {feeEquivalent,estimate:feeEquivalent*cfg.CRYPTO_MAKER_REBATE_RATE};
}
function clobWinner(up,down){
  if(!Number.isFinite(up)||!Number.isFinite(down))return null;
  return up>=.98?'UP':down>=.98?'DOWN':up>=down?'UP':'DOWN';
}
function clobQuotePrices(q){
  return [q?.mid,q?.bestBid,q?.bestAsk].filter(x=>x!=null&&x!=='').map(Number)
    .filter(x=>Number.isFinite(x)&&x>=0&&x<=1);
}
function clobQuoteValue(q){const prices=clobQuotePrices(q);return prices.length?Math.max(...prices):null}
function clobQuoteFloor(q){const prices=clobQuotePrices(q);return prices.length?Math.min(...prices):null}
function takeProfitHit(q,now=Date.now(),target=cfg.TAKE_PROFIT_PRICE){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid>=target}
function clobQuoteWinner(up,down){
  const upPrices=clobQuotePrices(up),downPrices=clobQuotePrices(down);
  const upHigh=upPrices.some(x=>x>=.98),downHigh=downPrices.some(x=>x>=.98);
  if(upHigh!==downHigh)return upHigh?'UP':'DOWN';
  const upLow=upPrices.some(x=>x<=.02),downLow=downPrices.some(x=>x<=.02);
  if(upLow!==downLow)return upLow?'DOWN':'UP';
  const u=clobQuoteValue(up),d=clobQuoteValue(down);
  if(u==null||d==null)return null;
  return u>=d?'UP':'DOWN';
}
class WickBot{
  constructor({timeframe='5m',windowMs=cfg.WINDOW_MS_5M,capital=cfg.DEMO_CAPITAL_5M,
    priceFeed=chainlinkFeed}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.priceFeed=priceFeed;
    this.marketRegime={state:'UNKNOWN',reason:'Waiting for fresh BTC price history'};
    this.startedAt=Date.now();
    this.positions=[];this.events=[];this.status='starting';this.completedWindows=new Map();
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.totalOrderAttempts=0;
    this.windowOrders=[];this.orderWindowStart=null;this.running=false;
        this.windowRungs={UP:new Set(),DOWN:new Set()};
    this.previousAskBySide={UP:null,DOWN:null};
          this.quoteWindowStart=null;this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
    this.closeQuotes=null;
    this.oppositeTakeProfitSide=null;
  }
  log(event,data={}){const e={ts:Date.now(),timeframe:this.timeframe,event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  captureQuotePair(now=Date.now(),source=this.liveQuotes,overrides={}){
    const numberOrNull=value=>value==null||value===''||!Number.isFinite(Number(value))?null:Number(value);
    return Object.fromEntries(['UP','DOWN'].map(side=>{
      const quote=overrides[side]||source?.[side]||{};
      const updatedAt=numberOrNull(quote.updatedAt);
      return [side,{
        status:quote.status||(quote.bestBid!=null||quote.bestAsk!=null?'LIVE':'MISSING'),
        bestBid:numberOrNull(quote.bestBid),bidSize:numberOrNull(quote.bidSize),
        bestAsk:numberOrNull(quote.bestAsk),askSize:numberOrNull(quote.askSize),
        mid:numberOrNull(quote.mid),updatedAt,
        ageMs:updatedAt==null?null:Math.max(0,now-updatedAt),
        stale:quote.stale===true||(updatedAt!=null&&now-updatedAt>5000),
      }];
    }));
  }
  captureExitQuotes(p,now,ownBid,hasBid=true){
    const source=p.closeQuotes||this.liveQuotes;
    const ownQuote={...(source?.[p.side]||{}),bestBid:hasBid?ownBid:null,updatedAt:now,
      status:hasBid?'LIVE':'MISSING'};
    p.exitQuotes=this.captureQuotePair(now,source,{[p.side]:ownQuote});
    p.exitQuoteAt=now;
  }
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
        this.closeQuotes=null;
      }
      await this.closePreviousWindows(start,now);
      if(!this.market||this.market.start!==start||now-this.lastMarketAt>cfg.MARKET_REFRESH_MS){
        this.market=await md.getBtcMarket(start,this.windowMs);this.lastMarketAt=now;
        if(!this.market){
          this.status='waiting_for_market';this.lastScanAt=now;
          if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{status:this.status,windowStart:start})}
          return;
        }
      }
      await this.refreshLiveQuotes(now);
      this.updateMarketRegime(now);
      if(this.orderWindowStart!==start)this.openStrategyWindow(start,now);
       this.processClimbEntries(start,now);
      if(now>=start+this.windowMs-3000&&now<start+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===start&&p.status==='OPEN')p.closeQuotes=this.closeQuotes;
      }
      this.lastScanAt=now;this.error=null;
      const hasOpen=this.positions.some(p=>p.windowStart===start&&p.status==='OPEN');
      this.status=this.completedWindows.has(start)?'window_complete':hasOpen?'position_open':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
  }
  async closePreviousWindows(currentStart,now=Date.now()){
    const previousOrders=this.orders.filter(order=>['PENDING','LIVE','MARKET_PENDING'].includes(order.status)&&order.windowStart!==currentStart);
    const open=this.positions.filter(p=>p.status==='OPEN'&&p.windowStart!==currentStart);
    if(!previousOrders.length&&!open.length)return 0;
    for(const order of previousOrders){
        order.status='EXPIRED_WINDOW_ROLLOVER';order.expiredAt=now;order.remainingShares=0;
    }
    const previousStarts=new Set([
      ...previousOrders.map(order=>order.windowStart),
      ...open.map(p=>p.windowStart),
    ]);
    for(const windowStart of previousStarts){
      if(Number.isFinite(Number(windowStart))&&!this.completedWindows.has(windowStart)){
        this.completedWindows.set(windowStart,{completedAt:now,reason:'WINDOW_ROLLOVER'});
      }
    }
    const quoteCache=new Map();
    const readQuote=async p=>{
      if(p.markBid!=null&&Number.isFinite(Number(p.markBid))&&Number.isFinite(p.markUpdatedAt)&&now-p.markUpdatedAt<=5000){
        return {bestBid:Number(p.markBid),updatedAt:p.markUpdatedAt,status:'LIVE'};
      }
      if(!p.tokenId)return null;
      if(!quoteCache.has(p.tokenId)){
        quoteCache.set(p.tokenId,md.getBook(p.tokenId).then(book=>quoteFromBook(book,now)).catch(()=>null));
      }
      return quoteCache.get(p.tokenId);
    };
    const quoted=await Promise.all(open.map(async p=>[p,await readQuote(p)]));
    for(const [p,q] of quoted){
      if(p.status!=='OPEN')continue;
      if(q?.bestBid!=null&&Number.isFinite(Number(q.bestBid))){
        p.markBid=Number(q.bestBid);p.markUpdatedAt=q.updatedAt||now;
        this.finalizeWindowLiquidation(p,Number(q.bestBid),'WINDOW_ROLLOVER_BID',now);
      }else{
        this.finalizeWindowLiquidation(p,0,'WINDOW_ROLLOVER_NO_BID',now);
      }
    }
    for(const windowStart of previousStarts){
      this.log('PAPER_WINDOW_ROLLED_OVER',{windowStart,currentStart,closedPositions:open.filter(p=>p.windowStart===windowStart).length,
        cancelledOrders:previousOrders.filter(order=>order.windowStart===windowStart).length});
    }
    return open.length;
  }
  updateMarketRegime(now=Date.now()){
    try{
      this.marketRegime=classifyRegime(this.priceFeed.getTicks(),now,{
        lookbackMs:cfg.CHOP_LOOKBACK_MS,sampleMs:cfg.CHOP_SAMPLE_MS,
        chopEfficiencyMax:cfg.CHOP_MIN_EFFICIENCY,minReversals:cfg.CHOP_MIN_REVERSALS,
        trendEfficiencyMin:cfg.TREND_MIN_EFFICIENCY,trendNetMoveMinPct:cfg.TREND_MIN_NET_MOVE_PCT,
      });
    }catch(error){
      this.marketRegime={state:'UNKNOWN',reason:error?.message||'BTC price feed unavailable'};
    }
    return this.marketRegime;
  }
  openStrategyWindow(start,now){
    this.orderWindowStart=start;
    this.lastEntryCheckpoint=0;
    this.windowOrders=[];
    this.oppositeTakeProfitSide=null;
    this.log('PAPER_CLIMB_WINDOW_STARTED',{windowStart:start,timeframe:this.timeframe});
    this.windowRungs={UP:new Set(),DOWN:new Set()};
    this.previousAskBySide={UP:null,DOWN:null};
  }
  getTakeProfitTarget(side){return this.oppositeTakeProfitSide===side?cfg.OPPOSITE_TAKE_PROFIT_PRICE:cfg.TAKE_PROFIT_PRICE}
  processClimbEntries(start,now){
    if(this.completedWindows.has(start)||this.orderWindowStart!==start||!this.market||this.market.start!==start)return;
    for(const side of ['UP','DOWN']){
      const quote=this.liveQuotes[side],ask=Number(quote?.bestAsk);
      const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&now-quote.updatedAt<=5000&&Number.isFinite(ask)&&ask>0&&ask<1;
      if(!fresh)continue;
      const previous=this.previousAskBySide[side];this.previousAskBySide[side]=ask;
      if(previous==null)continue;
      for(const triggerPrice of cfg.CLIMB_RUNGS){
        const key=triggerPrice.toFixed(2);
        const crossed=triggerPrice===cfg.CLIMB_RUNGS[0]?((previous<cfg.CLIMB_RUNGS[0]&&ask>=cfg.CLIMB_RUNGS[0])||(previous>cfg.CLIMB_RUNGS[0]&&ask<=cfg.CLIMB_RUNGS[0])):(previous<triggerPrice&&ask>=triggerPrice);
        if(this.windowRungs[side].has(key)||!crossed)continue;
        if(triggerPrice>cfg.CLIMB_RUNGS[0]&&!this.windowRungs[side].has(cfg.CLIMB_RUNGS[0].toFixed(2)))continue;
        const shares=cfg.CLIMB_SHARES,cost=ask*shares,fee=makerRebateFor(this.market,ask,shares).feeEquivalent;
        const id=`${this.timeframe}-${start}-${side}-climb-${key}`;
        const order={id,timeframe:this.timeframe,windowStart:start,side,tokenId:this.market.tokens[side],orderType:'MARKET',triggerPrice,shares,status:'FILLED',entryMode:'CLIMBING_PRICE_LADDER',entryType:'CLIMB_RUNG',createdAt:now,submittedAt:now,filledAt:now,fillPrice:ask,averageFillPrice:ask,fee,estimatedMakerRebate:0,fillModel:'PAPER_FRESH_ASK_AT_TRIGGER'};
        if(cost+fee>this.cash+1e-9){order.status='REJECTED_INSUFFICIENT_CASH';order.reason='Insufficient paper cash for this rung.';this.totalOrderAttempts++;this.orders.unshift(order);this.windowOrders.unshift(order);this.windowRungs[side].add(key);this.log('PAPER_CLIMB_RUNG_REJECTED',{id,side,triggerPrice,ask,shares,cash:this.cash});continue;}
        const position={id,timeframe:this.timeframe,windowMs:this.windowMs,windowStart:start,marketId:this.market.id,slug:this.market.slug,title:this.market.title,side,tokenId:this.market.tokens[side],entryKey:id,entryLabel:`${side} climb buy · trigger ${usdPrice(triggerPrice)}`,entryMode:'CLIMBING_PRICE_LADDER',entryType:'CLIMB_RUNG',rungPrice:triggerPrice,triggerPrice,orderType:'MARKET',fillModel:order.fillModel,shares,initialShares:shares,avgEntry:ask,fillPrice:ask,cost,totalCost:cost+fee,fees:fee,makerFeeEquivalent:0,estimatedMakerRebate:0,status:'OPEN',submittedAt:now,openedAt:now,filledAt:now,visibleAskSize:quote.askSize,simulatedShares:shares,submissionQuotes:this.captureQuotePair(now),entryQuotes:this.captureQuotePair(now),entryQuoteAt:now,entryRegime:{...this.marketRegime}};
        order.positionId=id;this.orders.unshift(order);this.windowOrders.unshift(order);this.positions.unshift(position);this.cash-=cost+fee;this.totalOrderAttempts++;this.windowRungs[side].add(key);
        this.log('PAPER_CLIMB_RUNG_FILLED',{id,windowStart:start,side,triggerPrice,price:ask,shares,cost,fee});
      }
    }
    if(this.orders.length>1000)this.orders.length=1000;
  }
  async refreshLiveQuotes(now){
    if(!this.market)return;
    const sides=['UP','DOWN'];
    const results=await Promise.allSettled(sides.map(side=>md.getBook(this.market.tokens[side])));
    sides.forEach((side,i)=>{const result=results[i];if(result.status==='fulfilled')this.liveQuotes[side]=quoteFromBook(result.value,now);else{const previous=this.liveQuotes[side]||{};const stale=previous.updatedAt?now-previous.updatedAt>10000:true;this.liveQuotes[side]={...previous,status:previous.updatedAt?(stale?'STALE':'LIVE'):'ERROR',stale,attemptedAt:now,error:result.reason?.message||'Order book unavailable'};}});
    this.processTakeProfitExits(now);
  }
  processTakeProfitExits(now){
    const open=this.positions.filter(p=>p.status==='OPEN'&&p.windowStart===this.market?.start);
    if(this.oppositeTakeProfitSide==null){const hitSides=new Set(open.filter(p=>takeProfitHit(this.liveQuotes[p.side],now,cfg.TAKE_PROFIT_PRICE)).map(p=>p.side));if(hitSides.size===1){const hitSide=[...hitSides][0];this.oppositeTakeProfitSide=hitSide==='UP'?'DOWN':'UP';this.log('PAPER_OPPOSITE_TP_RAISED',{hitSide,side:this.oppositeTakeProfitSide,takeProfitPrice:cfg.OPPOSITE_TAKE_PROFIT_PRICE});}}
    for(const p of open){const q=this.liveQuotes[p.side];p.markBid=q?.bestBid??null;p.markUpdatedAt=q?.updatedAt||now;p.markStatus=q?.bestBid!=null?'LIVE':'MISSING';const target=this.getTakeProfitTarget(p.side);if(takeProfitHit(q,now,target))this.finalizePosition(p,true,`TAKE_PROFIT_BID_${target.toFixed(2)}`,Number(q.bestBid));}
  }
  }
  finalizePosition(p,won,reason,triggerQuote){
    if(p.status!=='OPEN')return;
    const settledAt=Date.now();
    const takeProfit=String(reason).startsWith('TAKE_PROFIT_BID');
        p.payout=takeProfit?Number(triggerQuote):(won?1:0);
    p.proceeds=takeProfit?p.shares*p.payout:(won?p.shares:0);
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost;
    p.status='SETTLED_EXIT';
    p.settledAt=settledAt;
    p.settlementBasis=reason;
    p.exitReason=takeProfit?reason:null;
    p.tpTriggerQuote=takeProfit?triggerQuote:null;
    p.exitBid=Number.isFinite(Number(triggerQuote))?Number(triggerQuote):null;
    this.captureExitQuotes(p,settledAt,p.exitBid,p.exitBid!=null);
    this.cash+=p.proceeds;
    const event=takeProfit?'PAPER_TP_HIT':won?'PAPER_OFFICIAL_WIN':'PAPER_OFFICIAL_LOSS';
    this.log(event,{id:p.id,status:p.status,pnl:p.realizedPnl,side:p.side,shares:p.shares,
      proceeds:p.proceeds,triggerQuote,tpTarget:this.getTakeProfitTarget(p.side),reason});
  }
  finalizeWindowLiquidation(p,bid,reason,now=Date.now()){
    if(p.status!=='OPEN')return;
    const hasBid=reason.endsWith('_BID');
    p.payout=Math.max(0,Math.min(1,bid));
    p.proceeds=p.shares*p.payout;
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost;
    p.status='SETTLED_EXIT';
    p.settledAt=now;
    p.settlementBasis=reason;
    p.exitReason=reason;
    p.exitBid=hasBid?Number(bid):null;
    this.captureExitQuotes(p,now,p.exitBid,hasBid);
    this.cash+=p.proceeds;
    this.log(reason==='WINDOW_EXIT_NO_BID'?'PAPER_WINDOW_EXIT_NO_BID':'PAPER_WINDOW_EXIT_BID',
      {id:p.id,side:p.side,shares:p.shares,exitBid:p.exitBid,proceeds:p.proceeds,pnl:p.realizedPnl,windowStart:p.windowStart});
  }
  snapshot(){
    const now=Date.now();
    const realizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
     const takerFees=this.positions.reduce((s,p)=>s+(p.fees||0)+(p.exitFees||0),0);
     const estimatedMakerRebate=this.positions.reduce((s,p)=>s+(p.estimatedMakerRebate||0),0);
    const exits=this.positions.filter(p=>p.status==='SETTLED_EXIT').length;
    const profitableExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&(Number(p.realizedPnl)||0)>0).length;
    const losingExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&(Number(p.realizedPnl)||0)<0).length;
    const breakEvenExits=exits-profitableExits-losingExits;
     const wins=profitableExits,losses=losingExits;
     const settledTrades=exits;
    const totalTrades=this.positions.filter(p=>p.status!=='CANCELLED_UNFILLED').length;
    const history=this.positions.filter(p=>p.status==='SETTLED_EXIT')
      .sort((a,b)=>(a.settledAt||0)-(b.settledAt||0));
    const equityCurve=[{ts:this.startedAt,equity:this.capital}];
    let curveEquity=this.capital,peak=this.capital,maxDrawdown=0,maxConsecutiveLosses=0,lossStreak=0;
    for(const p of history){
      curveEquity+=Number(p.realizedPnl)||0;
      equityCurve.push({ts:p.settledAt||p.openedAt,equity:curveEquity});
      peak=Math.max(peak,curveEquity);maxDrawdown=Math.max(maxDrawdown,peak-curveEquity);
      if((Number(p.realizedPnl)||0)<0){lossStreak++;maxConsecutiveLosses=Math.max(maxConsecutiveLosses,lossStreak)}
      else lossStreak=0;
    }
    let unrealizedPnl=0,unpricedOpenPositions=0,markedValue=0;
    for(const p of this.positions){
      if(p.status!=='OPEN'){
        p.markValue=0;p.unrealizedPnl=0;p.markStatus='CLOSED';continue;
      }
      const mark=p.markBid==null?null:p.markBid*p.shares;p.markAgeMs=p.markUpdatedAt?Math.max(0,now-p.markUpdatedAt):null;p.markStatus=mark==null?'UNAVAILABLE':p.markAgeMs>15000?'STALE':'LIVE';const freshMark=mark!=null&&p.markAgeMs<=15000;p.markValue=freshMark?mark:null;p.unrealizedPnl=freshMark?mark-p.totalCost:null;if(!freshMark)unpricedOpenPositions++;else{markedValue+=mark;unrealizedPnl+=p.unrealizedPnl}
    }
     const inventory={UP:{shares:0,cost:0,averageCost:null,positions:0},DOWN:{shares:0,cost:0,averageCost:null,positions:0}};
      for(const p of this.positions){
         if(p.status!=='OPEN'||p.windowStart!==this.market?.start||!inventory[p.side])continue;
       const shares=Number(p.shares)||0;
       inventory[p.side].shares+=shares;
       inventory[p.side].cost+=Number(p.totalCost)||((Number(p.avgEntry)||0)*shares);
       inventory[p.side].positions++;
     }
     for(const side of ['UP','DOWN']){
       const sideInventory=inventory[side];
       sideInventory.averageCost=sideInventory.shares?sideInventory.cost/sideInventory.shares:null;
     }
      return {now,mode:'DEMO ONLY',status:this.status,error:this.error,
         strategy:{timeframe:this.timeframe,market:'Polymarket BTC 5-minute UP/DOWN',capital:this.capital,
               regime:{...this.marketRegime,entryPolicy:'Informational only; both sides climb independently.'},btcPriceFeed:this.priceFeed.snapshot(),entries:{orderType:'MARKET',sideIndependent:true,sharesPerRung:cfg.CLIMB_SHARES,takeProfitPrice:cfg.TAKE_PROFIT_PRICE,rungs:cfg.CLIMB_RUNGS.map(price=>({price,shares:cfg.CLIMB_SHARES})),oppositeTakeProfitSide:this.oppositeTakeProfitSide,oppositeTakeProfitPrice:cfg.OPPOSITE_TAKE_PROFIT_PRICE,sideLadders:Object.fromEntries(['UP','DOWN'].map(side=>{const triggered=[...this.windowRungs[side]].map(Number).sort((a,b)=>a-b),open=this.positions.filter(p=>p.status==='OPEN'&&p.windowStart===this.market?.start&&p.side===side),quote=this.liveQuotes[side]||{};return[side,{side,bestAsk:quote.bestAsk??null,bestBid:quote.bestBid??null,takeProfitPrice:this.getTakeProfitTarget(side),triggeredRungs:triggered,nextRung:cfg.CLIMB_RUNGS.find(price=>!this.windowRungs[side].has(price.toFixed(2)))??null,shares:open.reduce((n,p)=>n+Number(p.shares||0),0),openPositions:open.length}]})),direction:'Each side independently triggers its 100-share $0.25 pivot, then buys on upward crossings through $0.65.',timing:'No candle signal, recovery entry, or entry cutoff.',fill:'Paper market buy at the fresh best ask when a rung is crossed.',unfilled:'No resting entries; reached rungs fill immediately subject to available cash.'},merge:{enabled:false},exit:`Each position exits at its own-side bid at or above its current target (${cfg.TAKE_PROFIT_PRICE.toFixed(2)} normally; ${cfg.OPPOSITE_TAKE_PROFIT_PRICE.toFixed(2)} on the opposite side after a take-profit). Remaining positions close at window rollover using their own-side bid or $0 if unavailable.`,direction:'UP and DOWN are monitored independently.',entryFillModel:'Fresh own-side best ask at each crossing.',fees:'Paper entry fees are estimates from the market fee schedule.',execution:'PAPER ONLY'},
         account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,estimatedMakerRebate,
          totalTrades,settledTrades,wins,losses,profitableExits,losingExits,breakEvenExits,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
          openPositions:this.positions.filter(p=>p.status==='OPEN').length,
         maxConsecutiveLosses,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
          wins,losses,equityCurve},
       window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end,
         complete:this.completedWindows.has(this.market.start),completionReason:this.completedWindows.get(this.market.start)?.reason||null}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
        scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
           source:'Polymarket Gamma/CLOB plus Chainlink BTC/USD reference feed (regime is informational only)',
             marketResolution:`Each position exits at its own-side bid at or above ${cfg.TAKE_PROFIT_PRICE.toFixed(2)}; remaining positions close at window rollover.`},
       inventory,positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
      start(){if(this.running)return;this.running=true;this.priceFeed.start();this.log('BOT_STARTED',{timeframe:this.timeframe,note:'Paper-only two-sided climbing ladder: 100 shares at $0.25 and each $0.10 rise through $0.65; $0.75 take profit, with $0.99 on the opposite side after a TP.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer);this.priceFeed.stop()}
}
module.exports=WickBot;
module.exports._test={simulateAtBestAsk,quoteFromBook,clobWinner,clobQuoteWinner,clobQuoteValue,clobQuoteFloor,takeProfitHit};
