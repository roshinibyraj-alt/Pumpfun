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
html,body{background:#000;color:#fff;font-family:Arial,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}.wrap{max-width:1200px;margin:auto}
.topbar{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:8px}
.btc{width:38px;height:38px;border-radius:50%;background:#f7931a;display:grid;place-items:center;font-size:22px}
h1{font-size:19px;margin:0;line-height:1.1;text-transform:uppercase}
.sub{font-size:10px;color:var(--muted);letter-spacing:.4px;margin-top:2px}
.status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.pill{border:1px solid var(--line);padding:4px 7px;font-size:10px;white-space:nowrap;border-radius:6px}
.live{color:var(--up);border-color:#084b31}.bad{color:var(--down);border-color:#5c1622}.blue{color:var(--blue);border-color:#0d3a4a}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px}
.box{background:var(--panel);border:1px solid var(--line);padding:9px;border-radius:8px}
.label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.value{font-size:19px;margin-top:2px}.value.pos{color:var(--up)}.value.neg{color:var(--down)}
.small{font-size:9px;color:var(--muted);margin-top:2px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.clock{font-size:36px;line-height:1}.clock small{font-size:12px;color:var(--muted)}
.prices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.side{border:1px solid var(--line);padding:9px;background:#000;border-radius:8px}
.side-name{font-size:12px}.side-price{font-size:32px;line-height:1;margin:3px 0}
.side.up .side-price{color:var(--up)}.side.down .side-price{color:var(--down)}
.quote-row{display:flex;justify-content:space-between;font-size:12px}.quote-row span:last-child{color:#ddd}
.spread{display:inline-block;font-size:10px;color:var(--amber);margin-top:2px}
.section-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#fff;text-transform:uppercase}
.empty{color:var(--muted);padding:10px;border:1px dashed #333;text-align:center}
.chart{width:100%;height:100px;display:block}
.list{max-height:260px;overflow:auto;margin-top:6px}
.trade-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #161616;padding:7px 0;font-size:12px}
.buy{color:var(--up)}.sell{color:var(--down)}.dim{color:var(--muted);font-size:10px;font-weight:700}
.logs{height:200px;overflow:auto;background:#010407;border-radius:8px;padding:8px;font-family:"Courier New",monospace;font-size:10px;line-height:1.45;color:#e4e4e4;margin-top:6px;white-space:pre-wrap}
.log-win{color:var(--up)}.log-loss{color:var(--down)}.log-tp{color:var(--amber)}.log-info{color:var(--blue)}
.ord{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #111;padding:6px 0;font-size:11px}
.ord-buy{color:var(--up)}.ord-sell{color:var(--down)}.ord-fill{color:var(--amber)}.ord-cancel{color:var(--muted)}.ord-resolve{color:var(--blue)}
.winner{color:var(--up);font-weight:800}.loser{color:var(--down)}
@media(max-width:860px){.metrics{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}}
@media(max-width:720px){body{padding:6px;font-size:13px}h1{font-size:16px}.topbar{grid-template-columns:1fr}.side-price{font-size:28px}.clock{font-size:30px}}
</style>
</head>
<body><div class="wrap">
<header class="topbar">
<div class="brand"><div class="btc">₿</div><div><h1>LimitBot</h1><div class="sub">BUY BOTH SIDES @ $0.01 · 100 SH · HOLD TO POLYMARKET RESOLUTION</div></div></div>
<div class="status"><span id="waitPill" class="pill amber">WAIT</span><span id="statusPill" class="pill bad">OFFLINE</span><span id="uptimePill" class="pill blue">00:00:00</span></div>
</header>
<div class="metrics">
<div class="box"><div class="label">Bankroll</div><div class="value" id="bankroll">$100</div></div>
<div class="box"><div class="label">Total P&L</div><div class="value" id="totalPnl">$0</div></div>
<div class="box"><div class="label">Realized</div><div class="value" id="realizedPnl">$0</div></div>
<div class="box"><div class="label">Win / Loss</div><div class="value" id="winLoss">0 / 0</div><div class="small" id="winRate"></div></div>
</div>
<div class="two-col">
<div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Live BTC 5m</span><span id="windowTime">—</span></div>
<div id="marketBody"><div class="empty">Waiting for market...</div></div>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Active Orders</span><span id="activeCount"></span></div>
<div class="list"><div id="activeBody"><div class="empty">No active orders</div></div></div>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Open Positions</span><span id="posCount"></span></div>
<div class="list"><div id="posBody"><div class="empty">No open positions</div></div></div>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Resolved</span><span id="resCount"></span></div>
<div class="list"><div id="resBody"><div class="empty">No resolved yet</div></div></div>
</div>
</div>
<div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Equity</span></div>
<svg class="chart" id="equityChart"></svg>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Trade Feed</span><span id="tradeCount"></span></div>
<div class="list"><div id="feedBody"><div class="empty">No trades yet</div></div></div>
</div>
<div class="box">
<div class="section-head"><span>Logs</span><span id="logCount"></span></div>
<div class="logs" id="logBody"></div>
</div>
</div>
</div></div>
<script>
const S={};
const E=s=>String(s).replace(/[&<>"]/g,c=>({'+':'&#43;','&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const $=id=>document.getElementById(id);
const M=n=>{n=n||0;return(n>=0?'+':'−')+('$'+Math.abs(n).toFixed(2))};
const C=n=>'$'+Number(n||0).toFixed(2);
const N=n=>Number(n||0).toLocaleString();
const P=n=>n!=null?Number(n).toFixed(3):'—';
const T=n=>n>=0?'pos':'neg';
function U(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0')}
function renderMarket(m){const b=$('marketBody');if(!m){b.innerHTML='<div class="empty">Waiting for market...</div>';return}
const r=m.remaining||0,e=m.elapsed||0;
const wTag=m.resolved?'<span style="color:var(--up)">✓ '+m.winner+' WON</span>':'';
b.innerHTML='<div class="clock">'+r+'s<small> T+'+e+'s '+wTag+'</small></div><div class="prices">'
+'<div class="side up"><div class="side-name">▲ UP</div><div class="side-price">'+P(m.up.mid)+'</div>'
+'<div class="quote-row"><span>Bid</span><span>'+P(m.up.bid)+'</span></div>'
+'<div class="quote-row"><span>Ask</span><span>'+P(m.up.ask)+'</span></div>'
+(m.up.spread!=null?'<div class="spread">SPR '+P(m.up.spread)+'</div>':'')+'</div>'
+'<div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price">'+P(m.down.mid)+'</div>'
+'<div class="quote-row"><span>Bid</span><span>'+P(m.down.bid)+'</span></div>'
+'<div class="quote-row"><span>Ask</span><span>'+P(m.down.ask)+'</span></div>'
+(m.down.spread!=null?'<div class="spread">SPR '+P(m.down.spread)+'</div>':'')+'</div></div>'}
function renderActive(a){const b=$('activeBody'),c=$('activeCount');if(!a||!a.length){b.innerHTML='<div class="empty">No active orders</div>';c.textContent='';return}
c.textContent=a.length;b.innerHTML=a.map(o=>'<div class="ord"><div><span class="ord-buy">↗ BUY '+E(o.outcome)+'</span> · #'+o.id+'</div>'
+'<div>'+N(o.shares)+'sh @ '+P(o.price)+'</div>'
+'<div class="dim">'+new Date(o.createdAt).toLocaleTimeString()+'</div></div>').join('')}
function renderPos(orders){const filled=orders.filter(o=>o.status==='FILLED');const b=$('posBody'),c=$('posCount');
if(!filled.length){b.innerHTML='<div class="empty">No open positions</div>';c.textContent='0';return}
c.textContent=filled.length;b.innerHTML=filled.map(o=>{
const won=o.status==='RESOLVED'&&o.pnl>=0;const lost=o.status==='RESOLVED'&&o.pnl<0;
const cls=won?'winner':lost?'loser':'';
return '<div class="ord"><div><span class="'+cls+'">'+(won?'✅':lost?'❌':'⏳')+' '+E(o.outcome)+' #'+o.id+'</span></div>'
+'<div>'+N(o.shares)+'sh @ '+P(o.fillPrice)+' · cost '+C(o.totalCost)+'</div>'
+'<div class="'+T(o.pnl||0)+'">'+(o.pnl!=null?M(o.pnl):'HOLDING')+'</div></div>'}).join('')}
function renderRes(orders){const resolved=orders.filter(o=>o.status==='RESOLVED').slice(-20).reverse();const b=$('resBody'),c=$('resCount');
if(!resolved.length){b.innerHTML='<div class="empty">No resolved yet</div>';c.textContent='0';return}
c.textContent=resolved.length;b.innerHTML=resolved.map(o=>{const w=o.pnl>=0;
return '<div class="trade-item"><div><span class="'+(w?'buy':'sell')+'">'+(w?'✅':'❌')+' '+E(o.outcome)+' #'+o.id+'</span>'
+'<div class="dim">'+new Date(o.resolvedAt).toLocaleTimeString()+' · '+N(o.shares)+'sh @ '+P(o.fillPrice)+' · winner '+E(o.winner)+'</div></div>'
+'<div class="'+T(o.pnl)+'">'+M(o.pnl)+'</div></div>'}).join('')}
function renderFeed(t){const b=$('feedBody'),c=$('tradeCount');if(!t||!t.length){b.innerHTML='<div class="empty">No trades yet</div>';c.textContent='0';return}
c.textContent=t.length;b.innerHTML=t.map(tr=>{const cls=tr.type==='RESOLVED'?(tr.pnl>=0?'buy':'sell'):'buy';
return '<div class="trade-item"><div><span class="'+cls+'">'+tr.type+' '+E(tr.outcome||'')+'</span>'
+'<div class="dim">'+new Date(tr.timestamp).toLocaleTimeString()+' · '+N(tr.shares)+'sh @ '+P(tr.price)+'</div></div>'
+'<div style="text-align:right">'+(tr.pnl!=null?'<div class="'+(tr.pnl>=0?'buy':'sell')+'">'+M(tr.pnl)+'</div>':C(tr.cost||0))+'</div></div>'}).join('')}
function renderLogs(a){const b=$('logBody'),c=$('logCount');c.textContent=a.length+' LINES';
b.innerHTML=a.slice(-60).map(l=>{let cls='';if(l.includes('WIN'))cls='log-win';else if(l.includes('LOSS'))cls='log-loss';
else if(l.includes('💰')||l.includes('✅'))cls='log-tp';else if(l.includes('📋')||l.includes('🏁')||l.includes('🎯'))cls='log-info';
return '<div class="'+cls+'">'+E(l)+'</div>'}).join('')}
function renderChart(c){const svg=$('equityChart');if(!c||!c.length){svg.innerHTML='';return}
const v=c.map(p=>p.equity),lo=Math.min(...v),hi=Math.max(...v),rng=(hi-lo)||1;const W=700,H=100,P2=10;
const pts=c.map((p,i)=>[i/Math.max(1,c.length-1)*W,H-P2-(p.equity-lo)/rng*(H-P2*2)]);
const path='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');const last=pts.at(-1)||[0,H/2];
const color=S.totalPnl>=0?'#00ff85':'#ff4a68';
svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>'}
function renderKpi(d){$('bankroll').textContent=C(d.bankroll);
const tp=$('totalPnl');tp.textContent=M(d.totalPnl);tp.className='value '+T(d.totalPnl);
const rp=$('realizedPnl');rp.textContent=M(d.realizedPnl);rp.className='value '+T(d.realizedPnl);
$('winLoss').textContent=(d.wins||0)+' / '+(d.losses||0);$('winRate').textContent=d.winRate!=null?'Win '+d.winRate+'%':'';
const sp=$('statusPill');if(d.connected){sp.textContent='● LIVE';sp.className='pill live'}else{sp.textContent='● OFFLINE';sp.className='pill bad'}
$('uptimePill').textContent=U(d.uptime||0);
const wp=$('waitPill');if(d.waitingForWindow){const ww=Math.max(0,Math.ceil((d.entryWindow-Date.now()/1000)));wp.textContent='WAIT '+ww+'s';wp.className='pill amber'}
else{wp.textContent='TRADING';wp.className='pill live'}
const m=d.markets&&d.markets[0];$('windowTime').textContent=m?m.remaining+'s LEFT':'—'}
function fullRender(d){Object.assign(S,d);renderKpi(d);renderMarket(d.markets&&d.markets[0]);
renderActive(d.activeOrders);renderPos(d.orders||[]);renderRes(d.orders||[]);
renderFeed(d.trades);renderLogs(d.logs);renderChart(d.equityCurve)}
async function poll(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();fullRender(d)}catch(e){}}
setInterval(poll,1000);poll();
</script></body></html>`;

app.get('/healthz', (_, res) => res.sendStatus(200));
app.get('/api/status', (_, res) => res.json(engine.buildState()));
app.get('/', (_, res) => res.type('html').send(dashboard));
server.listen(port, '0.0.0.0', () => {
  console.log(`LimitBot listening on :${port}`);
  engine.init().catch(e => console.error(`Init: ${e.message}`));
});
