from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

from .strategy import NineEngineBot

app = FastAPI(title="Polymarket 9-Engine Bot (paper)")
bot: NineEngineBot = None


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/status")
async def status():
    if bot is None:
        return JSONResponse({"status": "not started"}, status_code=503)
    return bot.status()


DASHBOARD_HTML = """
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Polymarket 9-Engine Bot</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0a0e14; --panel: #10151d; --panel2: #141b25; --border: #1f2733;
    --text: #e6edf3; --muted: #7d8899; --up: #26d07c; --down: #ff5470;
    --accent: #58a6ff; --amber: #ffb454;
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, Segoe UI, Roboto, sans-serif;
    background: radial-gradient(1200px 600px at 20% -10%, #131b26 0%, var(--bg) 60%);
    color: var(--text); margin: 0; padding: 18px; min-height: 100vh;
  }
  .top { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
  h1 { font-size: 17px; font-weight:600; margin:0; }
  .badge { background:#3a1d00; color:var(--amber); border:1px solid #5c3400; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:600; }
  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--up); margin-right:6px; animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%{opacity:1} 50%{opacity:0.25} 100%{opacity:1} }

  .summary { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:10px; margin-bottom:18px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:12px 14px; }
  .card .label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
  .card .val { font-size:21px; font-weight:700; }
  .pnl-pos { color:var(--up); } .pnl-neg { color:var(--down); }

  .section-title { font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.6px; margin: 22px 0 10px; }

  .sides { display:flex; gap:14px; margin-bottom: 8px; }
  .sidecard { flex:1; background:var(--panel); border-radius:10px; padding:10px 14px; font-size:13px; }

  .engines { display:grid; grid-template-columns: repeat(auto-fit, minmax(230px,1fr)); gap:12px; }
  .ecard { background:var(--panel); border-radius:12px; padding:14px; border-top:3px solid var(--accent); }
  .ehead { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .ename { font-weight:700; font-size:13px; }
  .chip { font-size:9.5px; padding:2px 7px; border-radius:20px; font-weight:700; }
  .chip.real { background:#123424; color:var(--up); border:1px solid #1e5c3d; }
  .chip.shadow { background:#2a2410; color:var(--amber); border:1px solid #5c4a14; }
  .chip.holding { background:#0f2a3a; color:var(--accent); border:1px solid #1e4a5c; }
  .erow { display:flex; justify-content:space-between; font-size:11.5px; color:var(--muted); margin:3px 0; }
  .erow b { color: var(--text); font-variant-numeric: tabular-nums; }

  .pos { border-left:3px solid var(--amber); margin:6px 0; padding:8px 10px; background:var(--panel2); border-radius:6px; font-size:12px; }
  .empty { color: var(--muted); font-size: 12px; padding: 6px 0; }

  table { width:100%; border-collapse: collapse; font-size: 11.5px; background:var(--panel); border-radius:10px; overflow:hidden; margin-top:6px; }
  td, th { padding:5px 8px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:9.5px; }
  tr:last-child td { border-bottom:none; }
  .footer { color: var(--muted); font-size: 11px; margin-top:24px; text-align:center; }
</style>
</head>
<body>
  <div class="top">
    <h1><span class="pulse"></span>Polymarket 9-Engine Bot — BTC 5m</h1>
    <span class="badge">PAPER / DEMO MODE — NO REAL ORDERS</span>
  </div>

  <div class="summary" id="summary"></div>

  <div class="sides" id="sides"></div>

  <div class="section-title">9 Engines</div>
  <div class="engines" id="engines"></div>

  <div class="footer" id="footer"></div>

<script>
function fmt(n, d=3) { return (n === null || n === undefined) ? '&mdash;' : Number(n).toFixed(d); }
function mmss(s) { s = Math.max(0, Math.floor(s)); const m = Math.floor(s/60); const r = s%60; return m + ':' + String(r).padStart(2,'0'); }

async function refresh() {
  let d;
  try {
    const r = await fetch('/status');
    d = await r.json();
  } catch (e) { return; }
  if (!d || d.status === 'not started') return;

  const totalPnl = (d.total_balance ?? 0) - (d.total_starting_capital ?? 0);
  document.getElementById('summary').innerHTML = `
    <div class="card"><div class="label">Status</div><div class="val">${d.status ?? '-'}</div></div>
    <div class="card"><div class="label">Total balance (9 engines)</div><div class="val">$${fmt(d.total_balance,2)}</div></div>
    <div class="card"><div class="label">Starting total</div><div class="val">$${fmt(d.total_starting_capital,2)}</div></div>
    <div class="card"><div class="label">Total P&amp;L</div><div class="val ${totalPnl>=0?'pnl-pos':'pnl-neg'}">${totalPnl>=0?'+':''}$${fmt(totalPnl,2)}</div></div>
    <div class="card"><div class="label">Shares/trade</div><div class="val">${d.config?.shares_per_trade}</div></div>
    <div class="card"><div class="label">TP</div><div class="val">${d.config?.take_profit_trigger} &rarr; $1.00</div></div>
  `;

  const sides = d.sides || {};
  const w = d.window;
  document.getElementById('sides').innerHTML = Object.entries(sides).map(([name, s]) => `
    <div class="sidecard"><b>BTC ${name}</b> &middot; bid ${fmt(s.best_bid)} / ask ${fmt(s.best_ask)}
    ${w ? `&middot; ${mmss(w.seconds_left)} left in ${w.slug}` : ''}</div>
  `).join('') || '<div class="sidecard empty">discovering window&hellip;</div>';

  const engines = d.engines || {};
  document.getElementById('engines').innerHTML = Object.values(engines).map(e => {
    const pos = e.open_position;
    let chipHtml = '';
    if (pos) {
      chipHtml = `<span class="chip holding">${pos.is_shadow ? 'SHADOW' : 'HOLDING'}</span>`;
    } else if (e.kind === 'limit_cancel_skip') {
      chipHtml = `<span class="chip ${e.mode === 'SHADOW' ? 'shadow' : 'real'}">${e.mode}${e.mode==='SHADOW' ? ' (skip '+e.skip_counter+')' : ''}</span>`;
    } else {
      chipHtml = `<span class="chip real">ARMED</span>`;
    }
    const recent = (d.recent_by_engine?.[e.label] || []).slice(0,3);
    const recentHtml = recent.map(r => `
      <tr><td>${r.window_start}</td><td>${r.outcome}</td>
      <td class="${r.won?'pnl-pos':'pnl-neg'}">${r.won?'W':'L'}</td>
      <td class="${(r.raw_pnl||0)>=0?'pnl-pos':'pnl-neg'}">${(r.raw_pnl||0)>=0?'+':''}$${fmt(r.raw_pnl,2)}</td></tr>
    `).join('');
    const ruleText = e.kind === 'limit_cancel_skip'
      ? `Entry ${e.price} &middot; cancel-other &middot; TP only &middot; skip ${e.skip_length} after win`
      : `Trigger ${e.price} &middot; taker buy &middot; SL ${e.sl_price} &middot; TP ${d.config?.take_profit_trigger}`;
    return `
      <div class="ecard">
        <div class="ehead"><span class="ename">${e.label}</span>${chipHtml}</div>
        <div class="erow" style="font-size:10px;">${ruleText}</div>
        <div class="erow"><span>Balance</span><b>$${fmt(e.balance,2)}</b></div>
        ${pos ? `
        <div class="erow"><span>Position</span><b>${pos.outcome} @${fmt(pos.entry_price)}</b></div>
        <div class="erow"><span>Live bid</span><b>${fmt(pos.live_bid)}</b></div>
        <div class="erow"><span>Unrealized</span><b class="${(pos.unrealized_pnl||0)>=0?'pnl-pos':'pnl-neg'}">${pos.unrealized_pnl!=null?((pos.unrealized_pnl>=0?'+':'')+'$'+fmt(pos.unrealized_pnl,3)):'&mdash;'}</b></div>
        ` : ''}
        ${e.awaiting_count>0 ? `<div class="erow"><span>Awaiting resolution</span><b>${e.awaiting_count}</b></div>` : ''}
        <table><thead><tr><th>Win</th><th>Side</th><th>W/L</th><th>P&amp;L</th></tr></thead>
        <tbody>${recentHtml || '<tr><td colspan="4" class="empty">No history yet.</td></tr>'}</tbody></table>
      </div>`;
  }).join('') || '<div class="empty">starting up&hellip;</div>';

  document.getElementById('footer').innerText = `tick #${d.tick} &middot; updated ${new Date().toLocaleTimeString()}`;
}
refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return DASHBOARD_HTML
