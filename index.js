'use strict';
const express = require('express');
const http = require('http');
const { BotEngine, loadEquityFile } = require('./engine');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 8080;
const EQUITY_FILE = process.env.EQUITY_FILE || require('path').join(__dirname, 'equity.json');
const initialEquity = loadEquityFile(EQUITY_FILE);
const engine = new BotEngine({ initialEquity, onLog: l => console.log(l) });

const dashboard = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LimitBot — BTC 5m</title>
<style>
*{box-sizing:border-box}:root{--bg:#000;--panel:#070707;--line:#222;--muted:#9d9d9d;--up:#00ff85;--down:#ff4a68;--amber:#ffc400;--blue:#38d6ff}
html,body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}.wrap{max-width:1200px;margin:auto}
.topbar{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:8px}
.btc{width:38px;height:38px;border-radius:50%;background:#f7931a;display:grid;place-items:center;font-size:22px}
h1{font-size:19px;margin:0;line-height:1.1;text-transform:uppercase}
.sub{font-size:10px;color:var(--muted);letter-spacing:.4px;margin-top:2px}
.status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.pill{border:1px solid var(--line);padding:4px 7px;font-size:10px;white-space:nowrap;border-radius:6px}
.live{color:var(--up);border-color:#084b31}.bad{color:var(--down);border-color:#5c1622}.blue{color:var(--blue);border-color:#0d3a4a}.amber{color:var(--amber);border-color:#4a3a0d}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px}
.box,.panel{background:var(--panel);border:1px solid var(--line);padding:9px;border-radius:8px}
.label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.value{font-size:19px;margin-top:2px}.value.pos{color:var(--up)}.value.neg{color:var(--down)}.value.amb{color:var(--amber)}
.small{font-size:9px;color:var(--muted);margin-top:2px}
.two-col{display:grid;grid-template-columns:minmax(280px,1fr) minmax(260px,.75fr);gap:8px}
.clock{font-size:36px;line-height:1}.clock small{font-size:12px;color:var(--muted)}
.market{margin-bottom:8px}
.prices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.side{border:1px solid var(--line);padding:9px;background:#000;border-radius:8px}
.side-name{font-size:12px}.side-price{font-size:32px;line-height:1;margin:3px 0}
.side.up .side-price{color:var(--up)}.side.down .side-price{color:var(--down)}
.quote-row{display:flex;justify-content:space-between;font-size:12px}.quote-row span:last-child{color:#ddd}
.spread{display:inline-block;font-size:10px;color:var(--amber);margin-top:2px}
.section-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#fff;text-transform:uppercase}
.empty{color:var(--muted);padding:10px;border:1px dashed #333;text-align:center}
.chart{width:100%;height:120px;display:block}
.mini{background:#000;border:1px solid var(--line);padding:6px;border-radius:6px}
.mini .label{font-size:8px}.mini .value{font-size:13px}
.list{max-height:240px;overflow:auto;margin-top:6px}
.result,.trade-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #161616;padding:7px 0;font-size:12px}
.buy{color:var(--up)}.sell{color:var(--down)}.dim{color:var(--muted);font-size:10px;font-weight:700}
.logs{height:200px;overflow:auto;background:#010407;border-radius:8px;padding:8px;font-family:"Courier New",monospace;font-size:10px;line-height:1.45;color:#e4e4e4;margin-top:6px;white-space:pre-wrap}
.log-win{color:var(--up)}.log-loss{color:var(--down)}.log-tp{color:var(--amber)}.log-info{color:var(--blue)}
.order-card{background:#000;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;font-size:11px}
.order-buy{color:var(--up)}.order-sell{color:var(--down)}.order-wait{color:var(--amber)}
@media(max-width:860px){.metrics{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}}
@media(max-width:720px){body{padding:6px;font-size:13px}h1{font-size:16px}.topbar{grid-template-columns:1fr}.side-price{font-size:28px}.clock{font-size:30px}}
</style>
</head>
<body><div class="wrap">
<header class="topbar">
<div class="brand"><div class="btc">₿</div><div><h1>LimitBot</h1><div class="sub" id="strategy">BUY BOTH @ $0.01 · SELL @ $0.02 · 100 SH · CANCEL UNFILLED</div></div></div>
<div class="status"><span id="statusPill" class="pill bad">OFFLINE</span><span id="uptimePill" class="pill blue">00:00:00</span></div>
</header>
<div class="metrics">
<div class="box"><div class="label">Bankroll</div><div class="value" id="bankroll">$100</div></div>
<div class="box"><div class="label">Total P&L</div><div class="value" id="totalPnl">$0</div></div>
<div class="box"><div class="label">Realized</div><div class="value" id="realizedPnl">$0</div></div>
<div class="box"><div class="label">Wins / Losses</div><div class="value" id="winLoss">0 / 0</div><div class="small" id="winRate"></div></div>
<div class="box"><div class="label">Pending Orders</div><div class="value amb" id="pendingOrders">0</div><div class="small">BUY+SELL</div></div>
<div class="box"><div class="label">Filled Orders</div><div class="value" id="filledOrders">0</div><div class="small" id="maxDrawdown"></div></div>
<div class="box"><div class="label">Window</div><div class="value" id="windowTime">—</div><div class="small" id="windowElapsed"></div></div>
<div class="box"><div class="label">Config</div><div class="value" id="configLine">$0.01→$0.02</div></div>
</div>
<div class="two-col">
<div>
<div class="box market">
<div class="section-head"><span>Live BTC 5m</span><span id="windowTitle"></span></div>
<div id="marketBody"><div class="empty">Waiting for market...</div></div>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Active Orders</span><span id="orderCount"></span></div>
<div class="list"><div id="orderBody"></div></div>
</div>
<div class="box">
<div class="section-head"><span>Trades</span><span id="tradeCount"></span></div>
<div class="list"><div id="feedBody"></div></div>
</div>
</div>
<div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Equity</span></div>
<svg class="chart" id="equityChart"></svg>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Filled Orders</span><span id="filledCount"></span></div>
<div class="list"><div id="filledBody"></div></div>
</div>
<div class="box">
<div class="section-head"><span>Logs</span><span id="logCount"></span></div>
<div class="logs" id="logBody"></div>
</div>
</div>
</div></div>
<script>
const S={};
const ESC=s=>String(s).replace(/[&<>"]/g,c=>({'+':'&#43;','&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const $=id=>document.getElementById(id);
const money=n=>{n=n||0;return(n>=0?'+':'−')+('$'+Math.abs(n).toFixed(2))};
const cash=n=>'$'+Number(n||0).toFixed(2);
const num=n=>Number(n||0).toLocaleString();
const prc=n=>n!=null?Number(n).toFixed(3):'—';
const tone=n=>n>=0?'pos':'neg';
function uptimeFmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0')}
function renderMarket(m){const b=$('marketBody');if(!m){b.innerHTML='<div class="empty">Waiting for market...</div>';return}const r=m.remaining||0,e=m.elapsed||0;
b.innerHTML='<div class="clock">'+r+'s<small> T+'+e+'s</small></div><div class="prices">'
+'<div class="side up"><div class="side-name">▲ UP</div><div class="side-price">'+prc(m.up.mid)+'</div>'
+'<div class="quote-row"><span>Bid</span><span>'+prc(m.up.bid)+'</span></div>'
+'<div class="quote-row"><span>Ask</span><span>'+prc(m.up.ask)+'</span></div>'
+(m.up.spread!=null?'<div class="spread">SPR '+prc(m.up.spread)+'</div>':'')+'</div>'
+'<div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price">'+prc(m.down.mid)+'</div>'
+'<div class="quote-row"><span>Bid</span><span>'+prc(m.down.bid)+'</span></div>'
+'<div class="quote-row"><span>Ask</span><span>'+prc(m.down.ask)+'</span></div>'
+(m.down.spread!=null?'<div class="spread">SPR '+prc(m.down.spread)+'</div>':'')+'</div></div>';
$('windowTitle').textContent=m.title||''}
function renderOrders(orders){const b=$('orderBody'),ct=$('orderCount');if(!orders||!orders.length){b.innerHTML='<div class="empty">No active orders</div>';ct.textContent='0';return}
ct.textContent=orders.length;b.innerHTML=orders.map(o=>{const cls=o.type==='BUY'?'order-buy':'order-sell';
return '<div class="order-card"><div><span class="'+cls+'">'+(o.type==='BUY'?'↗ BUY':'↙ SELL')+' '+ESC(o.outcome)+'</span>'
+'<div class="dim">#'+o.id+' · '+num(o.shares)+'sh @ '+prc(o.price)+'</div></div>'
+'<div style="text-align:right;color:var(--amber)">'+new Date(o.createdAt).toLocaleTimeString()+' · WAITING</div></div>'}).join('')}
function renderFilled(a){const b=$('filledBody'),ct=$('filledCount');if(!a||!a.length){b.innerHTML='<div class="empty">No filled orders</div>';ct.textContent='0';return}
ct.textContent=a.length;b.innerHTML=a.map(o=>{const cls=o.type==='BUY'?'buy':'sell';
return '<div class="trade-item"><div><span class="'+cls+'">'+(o.type==='BUY'?'BUY':'SELL')+' '+ESC(o.outcome)+'</span>'
+'<div class="dim">#'+o.id+' · '+new Date(o.filledAt||o.createdAt).toLocaleTimeString()+' · '+num(o.shares)+'sh @ '+prc(o.fillPrice||o.price)+'</div></div>'
+'<div style="text-align:right;color:var(--muted)">'+(o.cost!=null?cash(o.cost):(o.pnl!=null?money(o.pnl):''))+'</div></div>'}).join('')}
function renderFeed(t){const b=$('feedBody'),ct=$('tradeCount');if(!t||!t.length){b.innerHTML='<div class="empty">No trades</div>';ct.textContent='0';return}
ct.textContent=t.length;b.innerHTML=t.slice(0,30).map(tr=>{const isSell=tr.type==='SELL'||tr.type==='RESOLVED';const cls=isSell?'sell':'buy';
return '<div class="trade-item"><div><span class="'+cls+'">'+tr.type+' '+ESC(tr.outcome||'')+'</span>'
+'<div class="dim">'+new Date(tr.timestamp).toLocaleTimeString()+' · '+num(tr.shares)+'sh @ '+prc(tr.price)+'</div></div>'
+'<div style="text-align:right">'+(tr.pnl!=null?'<div class="'+(tr.pnl>=0?'buy':'sell')+'">'+money(tr.pnl)+'</div>':'')+'</div></div>'}).join('')}
function renderLogs(a){const b=$('logBody'),ct=$('logCount');ct.textContent=a.length+' LINES';b.innerHTML=a.slice(-50).map(l=>{let c='';if(l.includes('WIN'))c='log-win';else if(l.includes('LOSS'))c='log-loss';else if(l.includes('💰'))c='log-tp';else if(l.includes('📋'))c='log-info';else if(l.includes('✅'))c='log-win';else if(l.includes('❌'))c='log-loss';return '<div class="'+c+'">'+ESC(l)+'</div>'}).join('')}
function renderChart(c){const svg=$('equityChart');if(!c||!c.length){svg.innerHTML='';return}
const v=c.map(p=>p.equity),lo=Math.min(...v),hi=Math.max(...v),rng=(hi-lo)||1;const W=700,H=120,P=12;
const pts=c.map((p,i)=>[i/Math.max(1,c.length-1)*W,H-P-(p.equity-lo)/rng*(H-P*2)]);
const path='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');const last=pts.at(-1)||[0,H/2];
const color=S&&S.totalPnl>=0?'#00ff85':'#ff4a68';
svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>'}
function renderKpi(d){$('bankroll').textContent=cash(d.bankroll);$('totalPnl').textContent=money(d.totalPnl);
const re=$('realizedPnl');re.textContent=money(d.realizedPnl);re.className='value '+tone(d.realizedPnl);
$('winLoss').textContent=(d.wins||0)+' / '+(d.losses||0);$('winRate').textContent=d.winRate!=null?'Win '+d.winRate+'%':'';
$('pendingOrders').textContent=d.orders?.pending||0;$('filledOrders').textContent=d.orders?.filled||0;
const dd=$('maxDrawdown');dd.textContent='DD '+cash(d.maxDrawdown||0);
const cfg=d.config||{};$('configLine').textContent='$'+(cfg.buyPrice||0.01)+'→$'+(cfg.sellPrice||0.02)+' · '+(cfg.shares||100)+'sh';
const sp=$('statusPill');if(d.connected){sp.textContent='● LIVE';sp.className='pill live'}else{sp.textContent='● OFFLINE';sp.className='pill bad'}
$('uptimePill').textContent=uptimeFmt(d.uptime||0);
const m=d.markets&&d.markets[0];if(m){$('windowTime').textContent=m.remaining+'s';$('windowElapsed').textContent='T+'+m.elapsed+'s'}else{$('windowTime').textContent='—';$('windowElapsed').textContent=''}}
function fullRender(d){Object.assign(S,d);renderKpi(d);renderMarket(d.markets&&d.markets[0]);renderOrders(d.activeOrders);renderFilled(d.filledOrders);renderFeed(d.trades);renderLogs(d.logs);renderChart(d.equityCurve)}
async function poll(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();fullRender(d)}catch(e){const sp=$('statusPill');if(sp){sp.textContent='● OFFLINE';sp.className='pill bad'}}}
setInterval(poll,1000);poll();
</script></body></html>`;

app.get('/healthz', (_, res) => res.sendStatus(200));
app.get('/api/status', (_, res) => res.json(engine.buildState()));
app.get('/', (_, res) => res.type('html').send(dashboard));
server.listen(port, '0.0.0.0', () => {
  console.log(`LimitBot listening on :${port}`);
  engine.init().catch(e => console.error(`Init: ${e.message}`));
});
