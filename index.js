'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MomentumLagEngine } = require('./engine');
const PolymarketTrader = require('./polymarket-trader');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const port = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const trader = PRIVATE_KEY ? new PolymarketTrader(PRIVATE_KEY) : null;
if (trader) trader.setLogFn((msg) => { console.log(msg); });
const engine = new MomentumLagEngine({
  onTick: (markets, messageCount) => io.emit('tick', { t: Date.now(), windowStart: markets[0]?.windowStart ?? null, messageCount, markets }),
  onLog: line => { console.log(line); io.emit('log', line); },
  trader,
});

const dashboard = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlatLine</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}html{color-scheme:dark}
body{background:#000;color:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;font-weight:700;padding:10px}
.shell{max-width:1500px;margin:auto}.topbar{display:flex;justify-content:space-between;gap:10px;align-items:center;background:#070b10;border:1px solid #172434;border-radius:14px;padding:12px;margin-bottom:9px}
h1{font-size:20px;letter-spacing:.3px}.sub{font-size:10px;color:#7f93a8;margin-top:2px}.brand-icon{font-size:24px}
.pills{display:flex;gap:5px;flex-wrap:wrap;justify-content:right}.pill{border:1px solid #22364b;background:#08111c;border-radius:999px;padding:5px 8px;font-size:9px;color:#9fb1c4;white-space:nowrap}
.live{color:#00ff9d;border-color:#00ff9d55;background:#00ff9d10}.warn{color:#ffc861;border-color:#ffc86155;background:#ffc86110}.bad{color:#ff5566;border-color:#ff556655;background:#ff556610}
.kpis{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:6px;margin-bottom:9px}.kpi,.panel,.market-card,.combo,.result,.feed-item{background:#060a0f;border:1px solid #16232f;border-radius:13px}
.kpi{padding:10px}.label{font-size:8px;text-transform:uppercase;color:#667e94;letter-spacing:.6px}.value{font-size:18px;margin-top:3px}.small{font-size:8px;color:#617589;font-weight:700}
.two-col{display:grid;grid-template-columns:1fr 320px;gap:9px;margin-bottom:9px}.panel{overflow:hidden}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid #14202c;font-size:11px;color:#8ea2b6}
.chart{height:155px;padding:5px}svg{width:100%;height:100%}.config-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:9px}.config-item{background:#080f18;border-radius:9px;padding:8px;font-size:8px;color:#657b91}.config-item b{display:block;font-size:11px;color:#fff;margin-top:2px}
.panel+.panel{margin-top:9px}.section{margin-bottom:9px}.markets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.market-card{padding:9px}.market-top{display:flex;justify-content:space-between;align-items:flex-start}.asset-name{font-size:15px}.timer{font-size:16px;color:#39d7ff;font-variant-numeric:tabular-nums;text-align:right}.timer small{display:block;font-size:8px;color:#65798d}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.side{background:#05090f;border:1px solid #152430;border-radius:10px;padding:8px}.side-label{font-size:10px;color:#8fa3b7}.up-label{color:#28e0a5}.down-label{color:#ff6b81}.mid{font-size:27px;line-height:1.15;font-variant-numeric:tabular-nums}.quote{font-size:9px;color:#7f93a8}.delta{font-size:9px;margin-top:2px}.green{color:#00ff9d!important}.red{color:#ff4a68!important}.blue{color:#38d6ff!important}.gold{color:#ffd166!important}
.combos,.results,.feeds{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.combo,.result,.feed-item{padding:10px}.combo-top{display:flex;justify-content:space-between;gap:6px}.combo-name{font-size:15px}.status{font-size:8px;color:#38d6ff;border:1px solid #38d6ff44;border-radius:99px;padding:3px 6px}.money{font-size:19px}.legs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.leg{background:#05090f;border-radius:9px;padding:7px}.leg b{font-size:14px;display:block}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:8px}.cell,.metric-cell{background:#05090f;border-radius:8px;padding:6px;font-size:8px;color:#677d92}.cell b,.metric-cell b{display:block;font-size:11px;color:#fff}
.result-name{font-size:14px}.winners{font-size:10px;color:#8da2b7;margin:3px 0}.feed-main{font-size:12px;margin-top:4px}.feed-detail{font-size:8px;color:#687e93;margin-top:2px}.tag-up,.tag-down{border-radius:6px;padding:2px 4px;font-size:9px}.tag-up{color:#28e0a5;background:#28e0a515}.tag-down{color:#ff6b81;background:#ff6b8115}.ctrl-panel{background:#060a0f;border:1px solid #16232f;border-radius:13px;padding:12px;margin-bottom:9px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ctrl-label{font-size:9px;text-transform:uppercase;color:#667e94;letter-spacing:.6px;margin-bottom:2px}
.toggle{position:relative;width:48px;height:24px;cursor:pointer}.toggle input{opacity:0;width:0;height:0}.slider{position:absolute;inset:0;background:#1a2a3a;border-radius:24px;transition:.2s}.slider:before{content:'';position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#445;font-radius:50%;transition:.2s}.toggle input:checked+.slider{background:#1a3a1a}.toggle input:checked+.slider:before{transform:translateX(24px);background:#00ff9d}
.ctrl-input{background:#080f18;border:1px solid #22364b;border-radius:8px;padding:6px 10px;color:#fff;font-size:12px;font-weight:700;width:70px;text-align:center;outline:none}.ctrl-input:focus{border-color:#38d6ff}
.ctrl-btn{background:#0a1a2a;border:1px solid #38d6ff44;color:#38d6ff;border-radius:8px;padding:6px 14px;font-size:10px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:.5px;transition:.2s}.ctrl-btn:hover{background:#38d6ff20}.ctrl-btn.danger{border-color:#ff4a6844;color:#ff4a68}.ctrl-btn.danger:hover{background:#ff4a6820}
.wallet-badge{font-size:9px;color:#667e94;background:#080f18;border:1px solid #172434;border-radius:8px;padding:5px 10px;font-family:SFMono-Regular,Consolas,monospace}
.logs{height:230px;overflow:auto;background:#010407;border-radius:10px;padding:8px;font-family:SFMono-Regular,Consolas,monospace;font-size:9px;font-weight:500;-webkit-overflow-scrolling:touch}.log{white-space:pre-wrap;color:#95a7b9;padding:1px 0}.empty{padding:16px;text-align:center;color:#445467;font
.flip-panel{background:#0a0014;border:1px solid #2d1a4e;border-radius:13px;overflow:hidden;margin-bottom:10px}
.flip-panel .panel-head{border-bottom:1px solid #2d1a4e}
.flip-pos{background:#080f18;border:1px solid #2d1a4e;border-radius:12px;padding:12px;margin:8px}
.flip-pos-header{display:flex;justify-content:space-between;align-items:center}
.flip-badge{font-size:8px;border-radius:99px;padding:3px 8px;font-weight:700;color:#c77dff;border:1px solid #c77dff44;background:#c77dff10}
.flip-pnl{font-size:20px;margin:4px 0;font-variant-numeric:tabular-nums}
.flip-metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin-top:8px}
.flip-metric{background:#0a0014;border-radius:7px;padding:5px 6px;font-size:8px;color:#9575cd}
.flip-metric b{display:block;font-size:11px;color:#fff;margin-top:1px}
.purple{color:#c77dff!important}-size:11px}
.stale{color:#ffc861!important}
@media(max-width:1150px){.kpis{grid-template-columns:repeat(4,minmax(0,1fr))}.markets{grid-template-columns:repeat(2,minmax(0,1fr))}.combos,.results,.feeds{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:720px){body{padding:7px}.topbar{flex-direction:column;align-items:stretch}.pills{justify-content:flex-start}.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.two-col{grid-template-columns:1fr}.markets,.combos,.results,.feeds{grid-template-columns:1fr}.mid{font-size:30px}.value,.money{font-size:20px}h1{font-size:17px}}
</style></head><body><div class="shell">
<header class="topbar"><div class="brand"><div class="brand-icon">🔗</div><div><h1>FlatLine</h1><div class="sub">BTC UP/DOWN + opposite alt side · combined mid &lt;0.85 · hold to resolution · CLOB book polling only</div></div></div><div class="pills"><span class="pill live" id="connection">UI LIVE</span><span class="pill warn" id="clobStatus">CLOB CONNECTING</span><span class="pill warn" id="discoveryStatus">DISCOVERY</span><span class="pill" id="rate">0/s</span><span class="pill" id="uptime">00:00</span></div></header>
<div class="ctrl-panel" id="ctrlPanel">
  <div><div class="ctrl-label">Trading Mode</div><label class="toggle"><input type="checkbox" id="liveToggle" onchange="toggleLive(this.checked)"><span class="slider"></span></label></div>
  <div id="modeLabel" style="font-size:12px;color:#ffc861;font-weight:700">🟡 PAPER</div>
  <div id="dryRunBadge" style="font-size:10px;color:#ff5566;border:1px solid #ff556644;border-radius:8px;padding:4px 10px;display:none">🔒 DRY_RUN</div>
  <div><div class="ctrl-label">Shares per Leg</div><input type="number" class="ctrl-input" id="sharesInput" value="10" min="1" max="10000" onchange="updateShares(this.value)"></div>
  <div><button class="ctrl-btn" id="authBtn" onclick="authTrader()">Authenticate Wallet</button></div>
  <div class="wallet-badge" id="walletBadge">No wallet</div><div class="wallet-badge" id="walletBalance" style="display:none;color:#00ff9d;border-color:#00ff9d44">💰 $<span id="balanceAmount">0.00</span></div>
</div>
<section class="kpis" id="kpis"></section>
<section class="two-col"><div class="panel"><div class="panel-head"><span>Global equity curve</span><strong id="equityValue">—</strong></div><div class="chart"><svg id="equityChart" preserveAspectRatio="none"></svg></div></div><div class="panel"><div class="panel-head"><span>Strategy & connection</span><strong>ACTIVE RULES</strong></div><div class="config-grid" id="configGrid"></div></div></section>
<section class="panel section"><div class="panel-head"><span>Live CLOB order books</span><strong id="tickInfo">WAITING</strong></div><div class="markets" id="marketsGrid"></div></section>
<section class="panel section"><div class="panel-head"><span>Open correlation combos</span><strong id="comboCount">0 OPEN</strong></div><div class="combos" id="combosGrid"></div></section>
<div class="flip-panel"><div class="panel-head"><span>⚡ BTC Flip Strategy</span><strong id="flipStatus">IDLE</strong></div><div style="padding:10px"><div id="flipPanel"></div></div></div><div class="two-col"><div class="panel"><div class="panel-head"><span>Resolved combos · last 2s >0.90</span><strong>SETTLED</strong></div><div class="results" id="resultsGrid" style="padding:8px"></div></div><div class="panel"><div class="panel-head"><span>Execution feed</span><strong>PAPER FOK LEGS</strong></div><div class="feeds" style="padding:8px" id="feedGrid"></div></div></div>
<section class="panel section"><div class="panel-head"><span>Live orders (real executions)</span><strong id="liveOrderCount">0 ORDERS</strong></div><div class="feeds" style="padding:8px" id="liveOrdersGrid"></div></section>
<section class="panel"><div class="panel-head"><span>Server activity</span><strong id="socketStatus">READY</strong></div><div class="logs" id="logsPanel"></div></section>
</div><script src="/socket.io/socket.io.js"></script><script>
let state=null,tickData=null,lastLivePacket=null,lastRender=0,priceHistory={},quoteSeen={},quoteStamps={},renderedMarketsKey='',lastMessages=0,lastRateAt=Date.now(),rateValue=0;
const $=id=>document.getElementById(id),socket=io({transports:['polling'],upgrade:false,reconnectionDelay:250,reconnectionDelayMax:1000,timeout:3000});
socket.on('connect',()=>{$('connection').textContent='UI LIVE';$('connection').className='pill live'});socket.on('disconnect',()=>{$('connection').textContent='UI RETRY';$('connection').className='pill warn'});
socket.on('log',line=>{logs.push(line);if(logs.length>300)logs.shift();safe(renderLogs)});socket.on('tick',data=>{if(acceptTick(data)){if(data.messageCount!=null)updateRate(data.messageCount);requestAnimationFrame(()=>safe(()=>{renderLivePrices(lastLivePacket,'CLOB TICK');renderFloating();lastRender=Date.now()}))}});
socket.on('state',data=>safe(()=>render(data)));
async function refreshState(){try{const response=await fetch('/api/status');render(await response.json())}catch(error){$('connection').textContent='UI RETRY';$('connection').className='pill warn'}}
refreshState();setInterval(refreshState,1000);fetch('/api/trader-info').then(r=>r.json()).then(d=>updateLiveUI(d)).catch(()=>{});setInterval(()=>{if(state&&state.traderAuthenticated)fetch("/api/trader-info").then(r=>r.json()).then(d=>updateLiveUI(d)).catch(()=>{})},1000);
function safe(fn){try{fn()}catch(error){console.error('Dashboard render error:',error)}}
function acceptTick(packet){if(!packet||!Array.isArray(packet.markets)||!packet.markets.length)return false;if(state&&packet.windowStart!==state.windowStart)return false;tickData=packet;lastLivePacket=packet;return true}
function num(v){return Number(v||0).toLocaleString(undefined,{maximumFractionDigits:2})}function cash(v){return'$'+Number(v||0).toFixed(2)}function money(v){if(v==null)return'—';const n=Number(v);return(n>0?'+$':n<0?'-$':'$')+Math.abs(n).toFixed(2)}function tone(v){return Number(v)>0?'green':Number(v)<0?'red':''}function price(v){return v==null?'—':Number(v).toFixed(3)}function clock(s){s=Math.max(0,Math.floor(s));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}function esc(x){return String(x||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function updateRate(count){const previous=lastMessages;lastMessages=count;if(Date.now()-lastRateAt>=1000){rateValue=Math.max(0,Math.round((count-previous)*1000/(Date.now()-lastRateAt)));lastRateAt=Date.now()}$('rate').textContent=rateValue+'/s'}
function validPacketFor(data,packet){return packet&&Array.isArray(packet.markets)&&packet.windowStart===data.windowStart&&packet.markets.some(market=>data.markets.some(current=>current.slug===market.slug))}
function render(data){const previousWindow=state?.windowStart;if(previousWindow!==data.windowStart){tickData=null;lastLivePacket=null;priceHistory={};quoteSeen={};quoteStamps={};renderedMarketsKey=''}state=data;$('uptime').textContent=clock(data.uptime);const clob=$('clobStatus');clob.textContent=data.connected?'CLOB LIVE':(data.trackedTokens?'CLOB POLL RETRY':'CLOB CONNECTING');clob.className='pill '+(data.connected?'live':'warn');const discovery=$('discoveryStatus');discovery.textContent=data.discovery.currentDiscovered+'/'+data.discovery.expectedMarkets+' NOW';discovery.className='pill '+(data.discovery.currentDiscovered===data.discovery.expectedMarkets?'live':'warn');
$('kpis').innerHTML=[['Equity',cash(data.markValue),'',cash(data.bankroll)+' bankroll'],['Total P&L',money(data.totalPnl),tone(data.totalPnl),'Since launch'],['Realized P&L',money(data.realizedPnl),tone(data.realizedPnl),'Settled combos'],['Floating P&L',money(data.unrealizedPnl),tone(data.unrealizedPnl),'Live mark'],['Open Cost',cash(data.openValue),'',data.combos.length+' combos'],['Win Rate',(data.winRate==null?'—':data.winRate+'%'),'',(data.wins||0)+'W / '+(data.losses||0)+'L'],['Combo Legs',num(data.positions.length),'',data.currentTradeShares+' SH each now'],['CLOB Polls',num(data.messageCount),'',data.pollCount+' batches']].map(item=>'<article class="kpi"><div class="label">'+item[0]+'</div><div class="value '+item[2]+'">'+item[1]+'</div><div class="small">'+item[3]+'</div></article>').join('');
$('equityValue').textContent=cash(data.markValue);renderChart(data.equityCurve||[]);$('configGrid').innerHTML=[['Entry','combined mid &lt; '+data.config.entryMaxSum.toFixed(2)],['Base size',data.config.baseTradeShares+' SH × each leg'],['Trade size',data.currentTradeShares+' SH per leg'],['Exit','hold to resolution'],['Resolution','final 2s > '+data.config.resolutionPrice.toFixed(2)],['Fees',data.config.feeBps+' bps'],['Bankroll',cash(data.bankroll)],['Window start',new Date(data.windowStart*1000).toLocaleTimeString()]].map(row=>'<div class="config-item">'+row[0]+'<b>'+row[1]+'</b></div>').join('');
const packet=validPacketFor(data,lastLivePacket)?lastLivePacket:{t:data.serverTime,windowStart:data.windowStart,markets:data.markets};buildMarkets(data.markets||[]);renderLivePrices(packet,validPacketFor(data,lastLivePacket)?'CLOB TICK':'STATE SNAPSHOT');renderCombos(data.combos||[]);renderResults(data.resolvedCombos||[]);renderFeed(data.trades||[]);
  renderFlip(data.flip);renderLogs()}
function marketKey(markets){return(state?.windowStart??'')+':'+markets.map(market=>market.slug).sort().join('|')}
function buildMarkets(markets){const key=marketKey(markets);if(key===renderedMarketsKey&&markets.every(market=>$('market-'+market.asset)))return;$('marketsGrid').innerHTML=markets.length?markets.map(market=>'<article class="market-card" id="market-'+market.asset+'"><div class="market-top"><div><div class="asset-name">'+market.asset.toUpperCase()+'</div><div class="small">'+market.slug+'</div></div><div class="timer" id="timer-'+market.asset+'">--:--<small>T+0s</small></div></div><div class="sides">'+sideHtml(market.asset,'UP')+sideHtml(market.asset,'DOWN')+'</div></article>').join(''):'<div class="empty">Discovering current-window books…</div>';renderedMarketsKey=key}
function sideHtml(asset,outcome){const id=(asset+'-'+outcome).toLowerCase();return'<div class="side"><div class="side-label '+outcome.toLowerCase()+'-label">'+outcome+'</div><div class="mid" id="mid-'+id+'">—</div><div class="quote">B <span id="bid-'+id+'">—</span> · A <span id="ask-'+id+'">—</span></div><div class="quote">SPR <span id="spread-'+id+'">—</span></div><div class="quote">AGE <span id="age-'+id+'">WAIT</span></div><div class="delta" id="delta-'+id+'">HOLD</div></div>'}
function rememberPrice(key,value){if(!Number.isFinite(value))return null;const now=Date.now(),list=priceHistory[key]||(priceHistory[key]=[]);list.push({t:now,p:value});while(list.length&&now-list[0].t>2500)list.shift();const old=list.find(item=>now-item.t<=1800&&item.p!==value)||list[0];return value-old.p}
function ageClass(seenAt){return seenAt&&Date.now()-seenAt<5000?'':' stale'}
function renderLivePrices(packet,source){if(!packet?.markets||!state)return;const now=Date.now();$('tickInfo').textContent=new Date(packet.t).toLocaleTimeString()+' · '+source+' · '+packet.markets.length+' BOOKS';for(const market of packet.markets){const card=$('market-'+market.asset);if(!card||!state.markets.some(current=>current.slug===market.slug))continue;$('timer-'+market.asset).innerHTML=clock(market.remaining)+'<small>T+'+market.elapsed+'s</small>';for(const side of ['up','down']){const token=market[side];if(!token)continue;const id=(market.asset+'-'+side).toLowerCase(),key=id+':'+market.slug,stamp=Number(token.updatedAt)||0;if(stamp&&quoteStamps[key]!==stamp){quoteStamps[key]=stamp;quoteSeen[key]=now}else if(stamp&&!quoteSeen[key])quoteSeen[key]=now;const seen=quoteSeen[key],stale=!seen||now-seen>=5000,delta=rememberPrice(key,token.mid);$('mid-'+id).textContent=price(token.mid);$('bid-'+id).textContent=price(token.bid);$('ask-'+id).textContent=price(token.ask);$('spread-'+id).textContent=token.spread==null?'—':token.spread.toFixed(3);const ageElement=$('age-'+id);ageElement.textContent=!stamp?'NO BOOK':!seen?'WAIT':now-seen<1000?'NOW':((now-seen)/1000).toFixed(1)+'s';ageElement.parentElement.className='quote'+(stale?' stale':'');const deltaElement=$('delta-'+id);deltaElement.textContent=delta==null?'HOLD':(delta>=0?'▲ +':'▼ ')+delta.toFixed(3);deltaElement.className='delta '+(delta>=0?'green':'red')}}}
function renderFloating(){if(!state)return;for(const combo of state.combos||[]){const element=$('floating-'+combo.id);if(element)element.textContent=money(combo.unrealized),element.className='money '+tone(combo.unrealized)}}
function renderCombos(combos){$('comboCount').textContent=combos.length+' OPEN';if(!combos.length){$('combosGrid').innerHTML='<div class="empty">No combo meets combined mid &lt;0.85 yet</div>';return}$('combosGrid').innerHTML=combos.map(combo=>'<article class="combo"><div class="combo-top"><div><div class="combo-name">'+esc(combo.name)+'</div><div class="small">ENTRY MID '+Number(combo.combinedEntryMid).toFixed(3)+' · T+'+Math.floor((Date.now()-combo.windowStart)/1000)+'s</div></div><span class="status">HOLDING</span></div><div class="metrics"><div class="metric-cell">COMBO COST<b>'+cash(combo.cost)+'</b></div><div class="metric-cell">MARK<b>'+cash(combo.markValue)+'</b></div><div class="metric-cell">FLOATING<b class="'+tone(combo.unrealized)+'">'+money(combo.unrealized)+'</b></div></div><div class="legs">'+combo.legs.map(leg=>'<div class="leg"><span class="small">'+leg.asset.toUpperCase()+' '+leg.outcome+'</span><b>'+num(leg.shares)+' SH</b><div class="small">ENTRY '+Number(leg.entryPrice).toFixed(3)+' · MARK '+Number(leg.markPrice??leg.entryPrice).toFixed(3)+'</div><div class="small">COST '+cash(leg.cost)+' · VALUE '+cash(leg.shares*(leg.markPrice??leg.entryPrice))+'</div></div>').join('')+'</div></article>').join('')}
function renderResults(results){if(!results.length){$('resultsGrid').innerHTML='<div class="empty">No settled combos yet</div>';return}$('resultsGrid').innerHTML=results.map(result=>'<article class="result"><div class="result-name">'+esc(result.name)+' · <span class="'+(result.pnl>=0?'green':'red')+'">'+result.result+'</span><div class="winners">'+esc(result.winner)+'</div></div><div class="money '+tone(result.pnl)+'">'+money(result.pnl)+'<div class="small-money">'+cash(result.payout)+' payout / '+cash(result.cost)+' cost</div></div></article>').join('')}
function renderFeed(trades){if(!trades.length){$('feedGrid').innerHTML='<div class="empty">Waiting for correlation entries…</div>';return}$('feedGrid').innerHTML=trades.slice(0,30).map(trade=>'<article class="feed-item"><div class="small">'+new Date(trade.timestamp).toLocaleTimeString()+' · '+esc(trade.signal.combo)+'</div><div class="feed-main"><span class="'+(trade.outcome==='UP'?'tag-up':'tag-down')+'">'+trade.asset.toUpperCase()+' '+trade.outcome+'</span> '+num(trade.shares)+' SH @ '+Number(trade.price).toFixed(3)+'</div><div class="feed-detail">Combined mid '+Number(trade.signal.combinedMid).toFixed(3)+' · '+cash(trade.cost)+' · FOK</div></article>').join('')}
function renderChart(curve){const svg=$('equityChart');if(!curve.length){svg.innerHTML='';return}const values=curve.map(point=>point.equity),low=Math.min(...values),high=Math.max(...values),range=(high-low)||1,width=700,height=160,pad=12,points=curve.map((point,index)=>[index/Math.max(1,curve.length-1)*width,height-pad-(point.equity-low)/range*(height-pad*2)]),path='M'+points.map(point=>point[0].toFixed(1)+','+point[1].toFixed(1)).join(' L'),last=points.at(-1)||[0,height/2],color=state.totalPnl>=0?'#15ff9c':'#ff4a68';svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="3"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="5" fill="'+color+'"/>'}
function renderLogs(){const panel=$('logsPanel'),nearBottom=panel.scrollHeight-panel.scrollTop-panel.clientHeight<50;panel.innerHTML=logs.slice(-220).map(line=>{let className='';if(line.includes('BUY'))className='log-info';else if(line.includes('WIN'))className='log-win';else if(line.includes('LOSS')||line.includes('⚠️'))className='log-loss';return'<div class="log '+className+'">'+esc(line)+'</div>'}).join('');if(nearBottom)panel.scrollTop=panel.scrollHeight}
async function toggleLive(on){try{const response=await fetch('/api/live-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:on})});const data=await response.json();updateLiveUI(data)}catch(error){console.error('Toggle failed:',error);$('liveToggle').checked=false}}
async function updateShares(value){try{await fetch('/api/live-shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shares:Number(value)})})}catch(error){console.error('Shares update failed:',error)}}
async function authTrader(){try{$('authBtn').textContent='AUTHENTICATING...';const response=await fetch('/api/live-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:state?.liveMode||false})});const data=await response.json();updateLiveUI(data)}catch(error){$('authBtn').textContent='AUTH FAILED'}}
function updateLiveUI(data){$('liveToggle').checked=!!data.liveMode;$('modeLabel').textContent=data.liveMode?'🔴 LIVE':'🟡 PAPER';$('modeLabel').style.color=data.liveMode?'#ff4a68':'#ffc861';$('authBtn').textContent=data.traderAuthenticated?'✅ AUTHENTICATED':'Authenticate Wallet';$('authBtn').className=data.traderAuthenticated?'ctrl-btn danger':'ctrl-btn';$('walletBadge').textContent=data.traderAddress?data.traderAddress.slice(0,10)+'...'+data.traderAddress.slice(-6):(data.hasPrivateKey?'No wallet':'No PRIVATE_KEY set');const dryBadge=$('dryRunBadge');if(data.dryRun){dryBadge.style.display='inline-block'}else{dryBadge.style.display='none'};const balEl=$('walletBalance');if(data.walletBalance!=null){balEl.style.display='inline-block';$('balanceAmount').textContent=Number(data.walletBalance).toFixed(2)}else if(data.traderAuthenticated){balEl.style.display='inline-block';$('balanceAmount').textContent='...'}else{balEl.style.display='none'}}
function renderLiveOrders(orders){if(!orders||!orders.length){$('liveOrdersGrid').innerHTML='<div class="empty">No live orders yet</div>';return}$('liveOrderCount').textContent=orders.length+' ORDERS';$('liveOrdersGrid').innerHTML=orders.slice(0,30).reverse().map(order=>'<article class="feed-item"><div class="small">'+new Date(order.timestamp).toLocaleTimeString()+' · '+esc(order.combo)+'</div><div class="feed-main"><span class="'+(order.outcome==='UP'?'tag-up':'tag-down')+'">'+order.asset.toUpperCase()+' '+order.outcome+'</span> '+num(order.shares)+' SH @ '+Number(order.avgPrice).toFixed(3)+'</div><div class="feed-detail">Order '+(order.status||'UNKNOWN')+' · id:'+(order.orderId||'?').slice(0,12)+'</div></article>').join('')}

function renderFlip(flip) {
  if (!flip) return;
  const statusEl = $('flipStatus');
  if (flip.open) {
    statusEl.textContent = 'FLIP #' + flip.windowCount + '/' + flip.maxFlips;
    statusEl.className = 'pill purple';
  } else if (flip.windowCount > 0) {
    statusEl.textContent = flip.windowCount + ' FLIPS DONE';
    statusEl.className = 'pill warn';
  } else {
    statusEl.textContent = 'IDLE — WAITING';
    statusEl.className = 'pill';
  }

  let html = '';
  if (flip.open) {
    const pos = flip.open;
    const markVal = pos.markValue || pos.cost;
    const unrl = pos.unrealized || 0;
    html += '<div class="flip-pos">'
      + '<div class="flip-pos-header"><div class="combo-name">⚡ FLIP #' + pos.flipIndex + ' — ' + esc(LEAD_ASSET.toUpperCase()) + ' ' + pos.outcome + '</div>'
      + '<span class="flip-badge">HOLDING</span></div>'
      + '<div class="flip-pnl ' + tone(unrl) + '">' + money(unrl) + '</div>'
      + '<div class="small">' + pos.shares + ' SH @ ' + prc(pos.entryPrice) + ' · Sunk $' + (flip.sunkCost||0).toFixed(2) + '</div>'
      + '<div class="flip-metrics">'
      + '<div class="flip-metric">ENTRY<b>' + prc(pos.entryPrice) + '</b></div>'
      + '<div class="flip-metric">MARK<b>' + prc(pos.markPrice) + '</b></div>'
      + '<div class="flip-metric">VALUE<b>' + cash(markVal) + '</b></div>'
      + '<div class="flip-metric">P&L<b class="' + tone(unrl) + '">' + money(unrl) + '</b></div>'
      + '<div class="flip-metric">FLIPS<b>' + flip.windowCount + '/' + flip.maxFlips + '</b></div>'
      + '</div></div>';
  } else {
    html += '<div style="text-align:center;padding:12px;color:#556677;font-size:10px">'
      + 'Waiting for BTC price near ' + (flip.entryPrice||0.60).toFixed(2) + ' (±' + (flip.tolerance||0.02).toFixed(2) + ')'
      + '<br>Sizing: ' + (flip.shares||[]).join(' → ') + ' shares · Max ' + (flip.maxFlips||2) + ' flips'
      + '<br>UP: ' + (flip.accumUpShares||0) + ' SH · DOWN: ' + (flip.accumDownShares||0) + ' SH'
      + '</div>';
  }

  if (flip.resolved && flip.resolved.length) {
    html += '<div style="margin-top:8px"><div class="small" style="color:#9575cd;padding:4px 0">RESOLVED</div>';
    for (const r of flip.resolved.slice(0, 5)) {
      const icon = r.result === 'WIN' ? '✅' : r.result === 'LOSS' ? '❌' : '➖';
      html += '<div style="display:flex;justify-content:space-between;padding:4px 8px;background:#080f18;border-radius:6px;margin-top:3px;font-size:10px">'
        + '<span>' + icon + ' ' + esc(r.name) + ' · Flip ' + (r.flipCount||0) + ' · UP ' + (r.upShares||0) + ' SH · DOWN ' + (r.downShares||0) + ' SH</span>'
        + '<span class="' + tone(r.pnl) + '">' + money(r.pnl) + '</span></div>';
    }
    html += '</div>';
  }

  $('flipPanel').innerHTML = html;
}
setInterval(()=>safe(()=>{if(lastLivePacket&&state&&lastLivePacket.windowStart===state.windowStart&&Date.now()-lastRender>=100){renderLivePrices(lastLivePacket,'CLOB TICK');renderFloating();lastRender=Date.now()}}),50);
</script></body></html>`;
app.use(require('express').json());
app.get('/healthz', (_, response) => response.sendStatus(200));
app.post('/api/live-mode', async (request, response) => {
  const { enabled } = request.body || {};
  if (typeof enabled !== 'boolean') return response.status(400).json({ error: 'enabled must be boolean' });
  if (enabled && engine.dryRun) {
    return response.status(403).json({ error: 'DRY_RUN=true — set DRY_RUN=false on Railway to enable live trading', dryRun: true, liveMode: false, traderAuthenticated: engine.traderAuthenticated, traderAddress: engine.traderAddress, hasPrivateKey: Boolean(PRIVATE_KEY) });
  }
  if (enabled && !engine.traderAuthenticated) {
    const ok = await engine.initTrader();
    if (!ok) return response.status(503).json({ error: 'Trader authentication failed', traderAddress: engine.traderAddress, hasPrivateKey: Boolean(PRIVATE_KEY) });
  }
  engine.setLiveMode(enabled);
  response.json({ liveMode: engine.liveMode, dryRun: engine.dryRun, traderAuthenticated: engine.traderAuthenticated, traderAddress: engine.traderAddress, hasPrivateKey: Boolean(PRIVATE_KEY), walletBalance: engine.walletBalance });
});
app.post('/api/live-shares', (request, response) => {
  const { shares } = request.body || {};
  if (typeof shares !== 'number' || shares < 1) return response.status(400).json({ error: 'shares must be a positive number' });
  engine.setLiveShares(shares);
  response.json({ liveShares: engine.liveShares });
});
app.get('/api/trader-info', (_, response) => {
  response.json({
    hasPrivateKey: Boolean(PRIVATE_KEY),
    address: engine.traderAddress,
    authenticated: engine.traderAuthenticated,
    liveMode: engine.liveMode,
    liveShares: engine.liveShares,
    dryRun: engine.dryRun,
    walletBalance: engine.walletBalance,
  });
});
app.get('/api/status', (_, response) => response.json(engine.buildState()));
app.get('/', (_, request) => request.type('html').send(dashboard));
io.on('connection', socket => socket.emit('state', engine.buildState()));
setInterval(() => io.emit('state', engine.buildState()), 250);
server.listen(port, '0.0.0.0', () => {
  console.log(`BTC correlation combo dashboard listening on :${port}`);
  engine.init().catch(error => console.error(`Init failure: ${error.message}`));
});
