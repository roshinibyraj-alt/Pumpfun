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
function payout(m,side){
  const outcomes=Array.isArray(m.outcomes)?m.outcomes:parse(m.outcomes);
  const prices=Array.isArray(m.outcomePrices)?m.outcomePrices:parse(m.outcomePrices);
  const idx=outcomes.findIndex(x=>String(typeof x==='string'?x:x.name||x.label).toUpperCase()===side);
  const status=String(m.status||'').toUpperCase();
  if(!(m.closed===true||m.resolved===true||['CLOSED','RESOLVED','SETTLED'].includes(status))||idx<0)return null;
  const p=Number(prices[idx]??(typeof outcomes[idx]==='object'?outcomes[idx].payout:NaN));
  return p>=.99?1:p<=.01?0:null;
}
function parse(x){if(typeof x==='string'){try{return JSON.parse(x)}catch(_){}}return []}
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
function takeProfitHit(q,now=Date.now()){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid>=.99}
function stopLossHit(q,now=Date.now()){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid<=.01}
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
    this.positions=[];this.events=[];this.status='starting';
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.windowOrders=[];this.orderWindowStart=null;this.running=false;
    this.quoteWindowStart=null;this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
    this.closeQuotes=null;
  }
  log(event,data={}){const e={ts:Date.now(),timeframe:this.timeframe,event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
        this.closeQuotes=null;
      }
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
      this.processTimedEntries(start,now);
      if(now>=start+this.windowMs-3000&&now<start+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===start&&(p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT'))p.closeQuotes=this.closeQuotes;
      }
      this.lastScanAt=now;this.error=null;
      for(const p of this.positions){
        if((p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT')
          &&now>=p.windowStart+this.windowMs
          &&now-(p.lastSettlementAttempt||0)>=1000) await this.trySettle(p);
      }
      const hasOpen=this.positions.some(p=>p.windowStart===start&&p.status==='OPEN');
      this.status=hasOpen?'position_open':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
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
    this.log('PAPER_NO_MERGE_STRATEGY_STARTED',{windowStart:start,
      checkIntervalSeconds:cfg.ENTRY_CHECK_INTERVAL_MS/1000,
      sharesPerSide:cfg.BASE_ENTRY_SHARES,
      limitOffset:cfg.LIMIT_PRICE_OFFSET,
      sides:['UP','DOWN'],
      mergeEnabled:false});
  }
  processTimedEntries(start,now){
    const elapsedMs=now-start;
    if(elapsedMs<cfg.ENTRY_CHECK_INTERVAL_MS||elapsedMs>=this.windowMs)return;
    const checkpoint=Math.floor(elapsedMs/cfg.ENTRY_CHECK_INTERVAL_MS);
    if(checkpoint<=this.lastEntryCheckpoint)return;
    this.lastEntryCheckpoint=checkpoint;
    for(const side of ['UP','DOWN']){
      const id=`${this.timeframe}-${start}-${side}-check-${checkpoint}`;
      this.attemptEntry(start,now,side,cfg.BASE_ENTRY_SHARES,checkpoint,id);
    }
  }
  attemptEntry(start,now,side,shares,checkpoint,id){
    const quote=this.liveQuotes[side],ask=Number(quote?.bestAsk),bid=Number(quote?.bestBid),mid=Number(quote?.mid);
    const order={id,timeframe:this.timeframe,windowStart:start,side,checkpoint,
      secondsIntoWindow:checkpoint*cfg.ENTRY_CHECK_INTERVAL_MS/1000,
      ask:Number.isFinite(ask)?ask:null,bid:Number.isFinite(bid)?bid:null,
      midpoint:Number.isFinite(mid)?mid:null,shares,orderType:'LIMIT',status:'SKIPPED',
      createdAt:now,entryType:'MIDPOINT_OFFSET'};
    this.windowOrders.unshift(order);this.orders.unshift(order);
    if(this.orders.length>1000)this.orders.length=1000;
    const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
      &&now-quote.updatedAt<=5000&&Number.isFinite(ask)&&Number.isFinite(bid)&&Number.isFinite(mid);
    if(!fresh){order.status='SKIPPED_STALE_QUOTE';order.reason='Fresh best bid and ask quotes are required.';return false}
    const limitPrice=Number((mid-cfg.LIMIT_PRICE_OFFSET).toFixed(3));
    if(limitPrice<=0||limitPrice>=1){
      order.status='SKIPPED_INVALID_LIMIT';
      order.reason='Midpoint minus the configured offset is outside the valid outcome-token price range.';
      return false;
    }
    const reserved=this.orders.reduce((sum,pending)=>sum+
      (pending.status==='PENDING'?(pending.limitPrice||0)*(pending.remainingShares||pending.shares||0):0),0);
    if(reserved+limitPrice*shares>this.cash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';
      order.reason='Insufficient paper cash after reserving for pending limit orders.';
      this.log('PAPER_ENTRY_REJECTED',{id,side,limitPrice,shares,reason:order.reason});
      return false;
    }
    order.limitPrice=limitPrice;order.remainingShares=shares;order.status='PENDING';
    order.submittedAt=now;order.quoteAtSubmission=quote.updatedAt;
    order.fillModel='PAPER_FRESH_ASK_WALK_THROUGH';order.fee=0;order.estimatedMakerRebate=0;
    this.log('PAPER_LIMIT_ORDER_PLACED',{id,side,checkpointSeconds:order.secondsIntoWindow,
      limitPrice,shares,ask,bid,midpoint:mid,fee:0});
    return true;
  }
  processPendingLimitOrders(now){
    for(const order of this.orders){
      if(order.status!=='PENDING')continue;
      if(now>=order.windowStart+this.windowMs){
        order.status='EXPIRED_UNFILLED';order.expiredAt=now;order.remainingShares=0;continue;
      }
      if(!this.market||this.market.start!==order.windowStart)continue;
      const quote=this.liveQuotes[order.side],ask=Number(quote?.bestAsk);
      const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
        &&now-quote.updatedAt<=5000&&quote.updatedAt>order.quoteAtSubmission&&Number.isFinite(ask);
      if(!fresh||ask>order.limitPrice+1e-9)continue;
      const shares=order.remainingShares||order.shares,cost=order.limitPrice*shares;
      const maker=makerRebateFor(this.market,order.limitPrice,shares);
      if(cost>this.cash+1e-9){
        order.status='REJECTED_INSUFFICIENT_CASH';
        order.reason='Cash was no longer available when the limit price was crossed.';
        order.remainingShares=0;continue;
      }
      const position={id:order.id,timeframe:this.timeframe,windowMs:this.windowMs,
        windowStart:order.windowStart,marketId:this.market.id,slug:this.market.slug,
        title:this.market.title,side:order.side,tokenId:this.market.tokens[order.side],
        entryKey:order.id,entryLabel:`${order.side} midpoint-offset limit buy ${usdPrice(order.limitPrice)} · ${shares} shares`,
        entryType:'CLOB_MIDPOINT_OFFSET',orderType:'LIMIT',fillModel:'PAPER_FRESH_ASK_WALK_THROUGH',
        shares,initialShares:shares,avgEntry:order.limitPrice,cost,totalCost:cost,fees:0,
        makerFeeEquivalent:maker.feeEquivalent,estimatedMakerRebate:maker.estimate,
        status:'OPEN',submittedAt:order.submittedAt,openedAt:now,filledAt:now,
        visibleAskSize:quote.askSize,simulatedShares:shares};
      order.status='FILLED';order.filledAt=now;order.positionId=order.id;
      order.fillPrice=order.limitPrice;order.fee=0;order.feeEquivalent=maker.feeEquivalent;
      order.estimatedMakerRebate=maker.estimate;order.remainingShares=0;
      this.cash-=cost;this.positions.unshift(position);
      this.log('PAPER_LIMIT_ORDER_FILLED',{id:order.id,side:order.side,limitPrice:order.limitPrice,
        walkedAsk:ask,shares,fee:0,feeEquivalent:maker.feeEquivalent,
        estimatedMakerRebate:maker.estimate,totalCost:cost});
    }
  }
  async refreshLiveQuotes(now){
    if(!this.market)return;
    const sides=['UP','DOWN'];
    const results=await Promise.allSettled(sides.map(side=>md.getBook(this.market.tokens[side])));
    sides.forEach((side,i)=>{
      const result=results[i];
      if(result.status==='fulfilled')this.liveQuotes[side]=quoteFromBook(result.value,now);
      else{
        const previous=this.liveQuotes[side]||{};
        const stale=previous.updatedAt?now-previous.updatedAt>10000:true;
        this.liveQuotes[side]={...previous,status:previous.updatedAt?(stale?'STALE':'LIVE'):'ERROR',stale,
          attemptedAt:now,error:result.reason?.message||'Order book unavailable'};
      }
    });
    this.processPendingLimitOrders(now);
    const open=this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT');
    for(const p of open){
      if(p.windowStart===this.market.start){
        const q=this.liveQuotes[p.side];
        p.markBid=q?.bestBid??null;p.markUpdatedAt=q?.updatedAt||now;p.markStatus=q?.bestBid!=null?'LIVE':'MISSING';
        if(p.status==='OPEN'){
          if(takeProfitHit(q,now))this.finalizePosition(p,true,'TAKE_PROFIT_BID',Number(q.bestBid));
          else if(stopLossHit(q,now))this.finalizePosition(p,false,'STOP_LOSS_BID',Number(q.bestBid));
        }
      }
    }
    const due=open.filter(p=>p.windowStart!==this.market.start&&p.tokenId&&now-(p.lastMarkAttempt||0)>=5000);
    await Promise.all(due.map(async p=>{
      p.lastMarkAttempt=now;
      try{const q=quoteFromBook(await md.getBook(p.tokenId),now);p.markBid=q.bestBid;p.markUpdatedAt=now;p.markStatus=q.bestBid!=null?'LIVE':'MISSING'}
      catch(_){p.markStatus=p.markBid!=null?'STALE':'MISSING'}
    }));
  }
  async trySettle(p){
    if(Date.now()<p.windowStart+(p.windowMs||this.windowMs))return;if(!['OPEN','PENDING_CLOB_RESULT'].includes(p.status))return;p.lastSettlementAttempt=Date.now();
    try{let market;try{market=await md.getMarket(p.marketId)}catch(_){market=await md.getBtcMarket(p.windowStart,p.windowMs||this.windowMs)}const result=payout(market,p.side);
      if(result==null){p.status='PENDING_CLOB_RESULT';p.settlementError='Waiting for Polymarket official resolution';if(!p.lastPendingLog||Date.now()-p.lastPendingLog>30000){p.lastPendingLog=Date.now();this.log('PAPER_OFFICIAL_RESULT_PENDING',{id:p.id,marketId:p.marketId})}return}
      this.finalizePosition(p,result===1,result===1?'OFFICIAL_RESOLUTION_WIN':'OFFICIAL_RESOLUTION_LOSS',null);
    }catch(e){p.status='PENDING_CLOB_RESULT';p.settlementError=e.message;if(!p.lastPendingLog||Date.now()-p.lastPendingLog>30000){p.lastPendingLog=Date.now();this.log('PAPER_OFFICIAL_RESULT_PENDING',{id:p.id,marketId:p.marketId,error:e.message})}}
  }
  finalizePosition(p,won,reason,triggerQuote){
    if(!['OPEN','PENDING_CLOB_RESULT'].includes(p.status))return;
    const takeProfit=reason==='TAKE_PROFIT_BID'||reason==='TP_HIT_0_99';
    const stopLoss=reason==='STOP_LOSS_BID'||reason.startsWith('STOP_LOSS_HIT_');
    p.payout=won?1:0;
    p.proceeds=won?p.shares:0;
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost;
    p.status=won?'SETTLED_WIN':'SETTLED_LOSS';
    p.settledAt=Date.now();
    p.settlementBasis=reason;
    p.exitReason=takeProfit||stopLoss?reason:null;
    p.tpTriggerQuote=takeProfit?triggerQuote:null;
    p.stopTriggerQuote=stopLoss?triggerQuote:null;
    p.winningSide=won?p.side:null;
    this.cash+=p.proceeds;
    const event=takeProfit?'PAPER_TP_HIT':stopLoss?'PAPER_STOP_LOSS':won?'PAPER_OFFICIAL_WIN':'PAPER_OFFICIAL_LOSS';
    this.log(event,{id:p.id,status:p.status,pnl:p.realizedPnl,side:p.side,shares:p.shares,
      proceeds:p.proceeds,triggerQuote,tpTarget:.99,stopLoss:p.stopLossThreshold??.01,reason});
  }
  snapshot(){
    const now=Date.now();
    const realizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
     const takerFees=this.positions.reduce((s,p)=>s+(p.fees||0)+(p.exitFees||0),0);
     const estimatedMakerRebate=this.positions.reduce((s,p)=>s+(p.estimatedMakerRebate||0),0);
    const officialWins=this.positions.filter(p=>p.status==='SETTLED_WIN').length;
    const officialLosses=this.positions.filter(p=>p.status==='SETTLED_LOSS').length;
    const exits=this.positions.filter(p=>p.status==='SETTLED_EXIT').length;
    const profitableExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&(Number(p.realizedPnl)||0)>0).length;
    const losingExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&(Number(p.realizedPnl)||0)<0).length;
    const breakEvenExits=exits-profitableExits-losingExits;
    const wins=officialWins+profitableExits,losses=officialLosses+losingExits;
    const settledTrades=officialWins+officialLosses+exits;
    const totalTrades=this.positions.filter(p=>p.status!=='CANCELLED_UNFILLED').length;
    const history=this.positions.filter(p=>p.status==='SETTLED_WIN'||p.status==='SETTLED_LOSS'||p.status==='SETTLED_EXIT')
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
      if(p.status!=='OPEN'&&p.status!=='PENDING_CLOB_RESULT'){
        p.markValue=0;p.unrealizedPnl=0;p.markStatus='CLOSED';continue;
      }
      const mark=p.markBid==null?null:p.markBid*p.shares;p.markAgeMs=p.markUpdatedAt?Math.max(0,now-p.markUpdatedAt):null;p.markStatus=mark==null?'UNAVAILABLE':p.markAgeMs>15000?'STALE':'LIVE';const freshMark=mark!=null&&p.markAgeMs<=15000;p.markValue=freshMark?mark:null;p.unrealizedPnl=freshMark?mark-p.totalCost:null;if(!freshMark)unpricedOpenPositions++;else{markedValue+=mark;unrealizedPnl+=p.unrealizedPnl}
    }
     const inventory={UP:{shares:0,cost:0,averageCost:null,positions:0},DOWN:{shares:0,cost:0,averageCost:null,positions:0}};
     for(const p of this.positions){
       if((p.status!=='OPEN'&&p.status!=='PENDING_CLOB_RESULT')||!inventory[p.side])continue;
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
            regime:{...this.marketRegime,entryPolicy:'Informational only; BTC regime does not block entries'},
           btcPriceFeed:this.priceFeed.snapshot(),
          entries:{orderType:'LIMIT',checkIntervalSeconds:cfg.ENTRY_CHECK_INTERVAL_MS/1000,
              baseShares:cfg.BASE_ENTRY_SHARES,sideIndependent:true,priceReference:'midpoint',
              limitOffset:cfg.LIMIT_PRICE_OFFSET,sides:['UP','DOWN'],
              timing:'Every 5 seconds, independently place 50-share UP and DOWN limit buys at each side midpoint minus $0.05',
              fill:'A limit fills only after a later fresh best ask walks down to or through its limit',
              unfilled:'Unfilled orders expire at the five-minute window close'},
          merge:{enabled:false},
          exit:'A fresh own-side best bid >= $0.99 settles at $1/share; <= $0.01 settles at $0/share. Positions hitting neither threshold settle from the official Gamma result after window close.',
          direction:'CLOB prices only; accumulate UP and DOWN positions independently; no shares are merged',
          entryFillModel:'Paper limit buys are priced five cents below each side midpoint; fill is confirmed when a later fresh best ask walks down to or through the limit',
          fees:'Maker fills have zero fees. Crypto rebate estimates are illustrative; actual daily rebates depend on market-wide maker activity.',
          execution:'PAPER ONLY'},
         account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,estimatedMakerRebate,
          totalTrades,settledTrades,wins,losses,profitableExits,losingExits,breakEvenExits,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
         openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT').length,
         maxConsecutiveLosses,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
          wins,losses,equityCurve},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
        scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
           source:'Polymarket Gamma/CLOB plus Chainlink BTC/USD reference feed (regime is informational only)',
          marketResolution:'Own-side fresh CLOB quote >= $0.99 settles $1/share, <= $0.01 settles $0/share immediately; otherwise official Gamma result is retried until resolved'},
       inventory,positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
     start(){if(this.running)return;this.running=true;this.priceFeed.start();this.log('BOT_STARTED',{timeframe:this.timeframe,note:'Paper-only BTC 5m independent UP/DOWN midpoint-offset limit buys; merges disabled; no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer);this.priceFeed.stop()}
}
module.exports=WickBot;
module.exports._test={simulateAtBestAsk,payout,quoteFromBook,clobWinner,clobQuoteWinner,clobQuoteValue,clobQuoteFloor,takeProfitHit,stopLossHit};
