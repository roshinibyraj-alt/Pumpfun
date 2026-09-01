'use strict';
const express = require('express');
const http = require('http');
const { BotEngine, loadEquityFile } = require('./engine');
const { SniperEngine } = require('./sniperEngine');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 8080;
const EQUITY_FILE = process.env.EQUITY_FILE || require('path').join(__dirname, 'equity.json');
const initialEquity = loadEquityFile(EQUITY_FILE);
const engine = new BotEngine({ initialEquity, onLog: l => console.log(l) });
const sniper = new SniperEngine({ markets: engine.markets, tokens: engine.tokens });

const dashboard = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Polymarket BTC 5m — LimitBot + SniperBot</title>
<style>
*{box-sizing:border-box}:root{--bg:#000;--panel:#070707;--line:#222;--muted:#9d9d9d;--up:#00ff85;--down:#ff4a68;--amber:#ffc400;--blue:#38d6ff;--purple:#c77dff}
html,body{background:#000;color:#fff;font-family:Arial,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}.wrap{max-width:1400px;margin:auto}
.topbar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:8px}
.btc{width:36px;height:36px;border-radius:50%;background:#f7931a;display:grid;place-items:center;font-size:20px}
h1{font-size:18px;margin:0}.sub{font-size:9px;color:var(--muted);letter-spacing:.4px;margin-top:2px}
.status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.pill{border:1px solid var(--line);padding:3px 6px;font-size:9px;white-space:nowrap;border-radius:6px}
.live{color:var(--up);border-color:#084b31}.bad{color:var(--down);border-color:#5c1622}.amber{color:var(--amber);border-color:#5c4a00}
.prices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.side{border:1px solid var(--line);padding:8px;background:#000;border-radius:8px}
.side-name{font-size:11px}.side-price{font-size:30px;line-height:1;margin:2px 0}
.side.up .side-price{color:var(--up)}.side.down .side-price{color:var(--down)}
.quote-row{display:flex;justify-content:space-between;font-size:11px}.quote-row span:last-child{color:#ddd}
.bot-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.bot-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:hidden}
.bot-card.limit{border-color:#333}.bot-card.sniper{border-color:#4a2d6e}
.bot-title{font-size:14px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.bot-title.limit{color:var(--blue)}.bot-title.sniper{color:var(--purple)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:6px}
.box{background:#0a0a0a;border:1px solid var(--line);padding:6px;border-radius:6px}
.label{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.value{font-size:16px;margin-top:1px}.value.pos{color:var(--up)}.value.neg{color:var(--down)}
.small{font-size:8px;color:var(--muted);margin-top:1px}
.section-head{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#fff;text-transform:uppercase;margin-top:6px;margin-bottom:3px}
.empty{color:var(--muted);padding:6px;border:1px dashed #333;text-align:center;font-size:10px}
.chart{width:100%;height:80px;display:block}
.list{max-height:180px;overflow:auto;margin-top:4px}
.trade-item{display:flex;justify-content:space-between;gap:6px;border-bottom:1px solid #161616;padding:4px 0;font-size:10px}
.buy{color:var(--up)}.sell{color:var(--down)}.dim{color:var(--muted);font-size:9px;font-weight:700}
.logs{height:140px;overflow:auto;background:#010407;border-radius:6px;padding:6px;font-family:"Courier New",monospace;font-size:9px;line-height:1.4;color:#e4e4e4;margin-top:4px;white-space:pre-wrap}
.log-win{color:var(--up)}.log-loss{color:var(--down)}.log-entry{color:var(--amber)}.log-info{color:var(--blue)}
.ord{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #111;padding:4px 0;font-size:10px}
.winner{color:var(--up);font-weight:800}.loser{color:var(--down)}
.clock{font-size:32px;line-height:1}.clock small{font-size:11px;color:var(--muted)}
@media(max-width:860px){.bot-grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}}
@media(max-width:720px){body{padding:6px;font-size:13px}h1{font-size:15px}.side-price{font-size:26px}.clock{font-size:28px}}
</style>
</head>
<body><div class="wrap">
<header class="topbar">
<div class="brand"><div class="btc">₿</div><div><h1>BTC 5m Dual Bot</h1><div class="sub">LIMITBOT + SNIPERBOT</div></div></div>
<div class="status"><span id="statusPill" class="pill bad">● OFFLINE</span><span id="uptimePill" class="pill"></span><span id="windowTime" class="pill amber">—</span></div>
</header>

<div class="prices">
<div class="side up"><div class="side-name">⬆ UP</div><div class="side-price" id="upPrice">—</div>
<div class="quote-row"><span>BID</span><span id="upBid">—</span></div>
<div class="quote-row"><span>ASK</span><span id="upAsk">—</span></div></div>
<div class="side down"><div class="side-name">⬇ DOWN</div><div class="side-price" id="dnPrice">—</div>
<div class="quote-row"><span>BID</span><span id="dnBid">—</span></div>
<div class="quote-row"><span>ASK</span><span id="dnAsk">—</span></div></div>
</div>

<div class="bot-grid">
<!-- LimitBot Card -->
<div class="bot-card limit">
<div class="bot-title limit">📋 LimitBot — $500</div>
<div class="metrics">
<div class="box"><div class="label">Capital</div><div class="value" id="lbCap">—</div></div>
<div class="box"><div class="label">P&L</div><div class="value" id="lbPnl">—</div></div>
<div class="box"><div class="label">W/L</div><div class="value" id="lbWL">—</div><div class="small" id="lbWR"></div></div>
<div class="box"><div class="label">Drawdown</div><div class="value" id="lbDD">—</div></div>
</div>
<div class="section-head"><span>Position</span><span id="lbPosCnt">0</span></div>
<div id="lbPos" class="list"><div class="empty">No positions</div></div>
<div class="section-head"><span>Trades</span><span id="lbTrdCnt">0</span></div>
<div id="lbTrd" class="list"><div class="empty">No trades</div></div>
<svg class="chart" id="lbChart" viewBox="0 0 700 80" preserveAspectRatio="none"></svg>
<div class="section-head"><span>Logs</span><span id="lbLogCnt">0</span></div>
<div id="lbLogs" class="logs"></div>
</div>

<!-- SniperBot Card -->
<div class="bot-card sniper">
<div class="bot-title sniper">🎯 SniperBot — $150</div>
<div class="metrics">
<div class="box"><div class="label">Capital</div><div class="value" id="sbCap">—</div></div>
<div class="box"><div class="label">P&L</div><div class="value" id="sbPnl">—</div></div>
<div class="box"><div class="label">W/L</div><div class="value" id="sbWL">—</div><div class="small" id="sbWR"></div></div>
<div class="box"><div class="label">Next Bet</div><div class="value" id="sbBet">—</div><div class="small" id="sbLosses"></div></div>
</div>
<div class="section-head"><span>Position</span><span id="sbPosCnt">0</span></div>
<div id="sbPos" class="list"><div class="empty">No positions</div></div>
<div class="section-head"><span>Trades</span><span id="sbTrdCnt">0</span></div>
<div id="sbTrd" class="list"><div class="empty">No trades</div></div>
<svg class="chart" id="sbChart" viewBox="0 0 700 80" preserveAspectRatio="none"></svg>
<div class="section-head"><span>Logs</span><span id="sbLogCnt">0</span></div>
<div id="sbLogs" class="logs"></div>
</div>
</div>

<script>
const E=v=>{if(v==null)return'—';const s=String(v);const d=document.createElement('div');d.textContent=s;return d.innerHTML};
const C=v=>'$'+Number(v||0).toFixed(2);
const M=v=>{const n=Number(v||0);return(n>=0?'+':'-')+'$'+Math.abs(n).toFixed(2)};
const T=v=>Number(v||0)>=0?'pos':'neg';
const P=v=>v!=null?'$'+Number(v).toFixed(2):'—';
const N=v=>Number(v||0).toLocaleString();
const U=s=>{const m=Math.floor(s/60),sec=s%60;return m+'m'+(sec<10?'0':'')+sec+'s'};
const S={};

function renderMarket(m){if(!m)return;
$('upPrice').textContent=P(m.up?.mid);$('upBid').textContent=P(m.up?.bid);$('upAsk').textContent=P(m.up?.ask);
$('dnPrice').textContent=P(m.down?.mid);$('dnBid').textContent=P(m.down?.bid);$('dnAsk').textContent=P(m.down?.ask);
$('windowTime').textContent=m.remaining+'s LEFT'}

function renderLbPos(orders){const filled=orders.filter(o=>o.status==='FILLED');const b=$('lbPos');$('lbPosCnt').textContent=filled.length;
if(!filled.length){b.innerHTML='<div class="empty">No open positions</div>';return}
b.innerHTML=filled.map(o=>{const won=o.status==='RESOLVED'&&o.pnl>=0;const lost=o.status==='RESOLVED'&&o.pnl<0;const cls=won?'winner':lost?'loser':'';
return '<div class="ord"><div><span class="'+cls+'">'+(won?'✅':lost?'❌':'⏳')+' '+E(o.outcome)+' #'+o.id+'</span></div>'
+'<div>'+N(o.shares)+'sh @ '+P(o.fillPrice)+'</div>'
+'<div class="'+T(o.pnl||0)+'">'+(o.pnl!=null?M(o.pnl):'HOLDING')+'</div></div>'}).join('')}

function renderLbTrd(trades){const b=$('lbTrd');$('lbTrdCnt').textContent=trades.length;
if(!trades.length){b.innerHTML='<div class="empty">No trades yet</div>';return}
b.innerHTML=trades.slice(0,20).map(tr=>{const cls=tr.pnl!=null?(tr.pnl>=0?'buy':'sell'):'buy';
return '<div class="trade-item"><div><span class="'+cls+'">'+tr.type+' '+E(tr.outcome||'')+'</span>'
+'<div class="dim">'+new Date(tr.timestamp).toLocaleTimeString()+' · '+N(tr.shares)+'sh @ '+P(tr.price)+'</div></div>'
+'<div style="text-align:right">'+(tr.pnl!=null?'<div class="'+(tr.pnl>=0?'buy':'sell')+'">'+M(tr.pnl)+'</div>':C(tr.cost||0))+'</div></div>'}).join('')}

function renderLbLogs(a){const b=$('lbLogs');$('lbLogCnt').textContent=a.length+' LINES';
b.innerHTML=a.slice(-40).map(l=>{let cls='';if(l.includes('WIN'))cls='log-win';else if(l.includes('LOSS'))cls='log-loss';
else if(l.includes('✅')||cls.includes('tp'))cls='log-entry';else if(l.includes('📋')||l.includes('🏁')||l.includes('🎯'))cls='log-info';
return '<div class="'+cls+'">'+E(l)+'</div>'}).join('')}

function renderSbPos(pos){const b=$('sbPos');$('sbPosCnt').textContent=pos?1:0;
if(!pos){b.innerHTML='<div class="empty">No position</div>';return}
b.innerHTML='<div class="ord"><div><span class="">⏳ '+E(pos.side)+'</span></div>'
+'<div>'+N(pos.shares)+'sh @ '+P(pos.fillPrice)+'</div>'
+'<div class="small">cost '+C(pos.cost)+'</div></div>'}

function renderSbTrd(trades){const b=$('sbTrd');$('sbTrdCnt').textContent=trades.length;
if(!trades.length){b.innerHTML='<div class="empty">No trades yet</div>';return}
b.innerHTML=trades.slice(0,20).map(tr=>{const cls=tr.pnl!=null?(tr.pnl>=0?'buy':'sell'):'buy';
return '<div class="trade-item"><div><span class="'+cls+'">'+tr.type+' '+E(tr.outcome||'')+'</span>'
+'<div class="dim">'+new Date(tr.timestamp).toLocaleTimeString()+' · '+N(tr.shares)+'sh @ '+P(tr.price)+'</div></div>'
+'<div style="text-align:right">'+(tr.pnl!=null?'<div class="'+(tr.pnl>=0?'buy':'sell')+'">'+M(tr.pnl)+'</div>':C(tr.cost||0))+'</div></div>'}).join('')}

function renderSbLogs(a){const b=$('sbLogs');$('sbLogCnt').textContent=a.length+' LINES';
b.innerHTML=a.slice(-40).map(l=>{let cls='';if(l.includes('WIN'))cls='log-win';else if(l.includes('LOSS'))cls='log-loss';
else if(l.includes('🎯')||l.includes('ENTRY'))cls='log-entry';else if(l.includes('SL')||l.includes('RES'))cls='log-info';
return '<div class="'+cls+'">'+E(l)+'</div>'}).join('')}

function renderChart(svgId,c,pnl){const svg=$(svgId);if(!c||!c.length){svg.innerHTML='';return}
const v=c.map(p=>p.equity),lo=Math.min(...v),hi=Math.max(...v),rng=(hi-lo)||1;const H=80,P2=8;
const pts=c.map((p,i)=>[i/Math.max(1,c.length-1)*700,H-P2-(p.equity-lo)/rng*(H-P2*2)]);
const path='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');const last=pts.at(-1)||[0,H/2];
const color=pnl>=0?'#00ff85':'#ff4a68';
svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="3" fill="'+color+'"/>'}

function renderKpi(d,prefix){const p=prefix;
$(p+'Cap').textContent=C(d.capital);
const tp=$(p+'Pnl');tp.textContent=M(d.totalPnl);tp.className='value '+T(d.totalPnl);
$(p+'WL').textContent=(d.wins||0)+' / '+(d.losses||0);
const wr=$(p+'WR');if(wr)wr.textContent=d.winRate!=null?'Win '+d.winRate+'%':'';
}

function fullRender(data){
const d=data.limit||{};const s=data.sniper||{};
Object.assign(S,data);

// Status pills
const sp=$('statusPill');
const anyConnected=(d.connected||s.connected);
if(anyConnected){sp.textContent='● LIVE';sp.className='pill live'}else{sp.textContent='● OFFLINE';sp.className='pill bad'}
$('uptimePill').textContent=U(d.uptime||0);

// Market
renderMarket(data.markets&&data.markets[0]);

// LimitBot
renderKpi(d,'lb');
const ddEl=$('lbDD');ddEl.textContent=C(d.maxDrawdown||0);
renderLbPos(d.orders||[]);
renderLbTrd(d.trades||[]);
renderChart('lbChart',d.equityCurve,d.totalPnl);
renderLbLogs(d.logs||[]);

// SniperBot
renderKpi(s,'sb');
$('sbBet').textContent=C(s.currentBet||0);
const slEl=$('sbLosses');if(slEl)slEl.textContent='Consec losses: '+(s.consecutiveLosses||0);
renderSbPos(s.position);
renderSbTrd(s.trades||[]);
renderChart('sbChart',s.equityCurve,s.totalPnl);
renderSbLogs(s.logs||[]);
}

async function poll(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();fullRender(d)}catch(e){}}
setInterval(poll,1000);poll();
</script></body></html>`;

app.get('/healthz', (_, res) => res.sendStatus(200));
app.get('/api/status', (_, res) => {
  const state = engine.buildState();
  state.markets = engine.publicMarkets();
  res.json({ limit: state, sniper: sniper.buildState(), markets: engine.publicMarkets() });
});
app.get('/', (_, res) => res.type('html').send(dashboard));
server.listen(port, '0.0.0.0', async () => {
  console.log(`LimitBot + SniperBot listening on :${port}`);
  try {
    await engine.init();
    // Start sniper evaluate loop (shares markets/tokens with engine)
    setInterval(() => sniper.evaluate(), 100);
    console.log('🚀 Both engines started');
  } catch(e) { console.error(`Init: ${e.message}`); }
});
