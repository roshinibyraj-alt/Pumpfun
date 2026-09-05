from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

from . import config
from .strategy import Bot

app = FastAPI(title="Polymarket Cross-Market Bot (paper) -- 5m + 15m")
bots: dict = {}  # label -> Bot, set by main.py


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/status")
async def status():
    """Combined status for BOTH independent instances, keyed by label."""
    if not bots:
        return JSONResponse({"status": "not started"}, status_code=503)
    return {label: bot.status() for label, bot in bots.items()}


@app.get("/status/{instance}")
async def status_one(instance: str):
    bot = bots.get(instance)
    if bot is None:
        return JSONResponse({"error": f"unknown instance '{instance}'"}, status_code=404)
    return bot.status()


DASHBOARD_HTML = """
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Polymarket Cross-Market Bot — 5m + 15m</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0a0e14; --panel: #10151d; --panel2: #141b25; --border: #1f2733;
    --text: #e6edf3; --muted: #7d8899; --up: #26d07c; --down: #ff5470;
    --accent: #58a6ff; --amber: #ffb454; --shadow: 0 1px 0 rgba(255,255,255,0.03) inset;
    --c5m: #4dd8e8; --c15m: #c792ea;
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, Segoe UI, Roboto, sans-serif;
    background: radial-gradient(1200px 600px at 20% -10%, #131b26 0%, var(--bg) 60%);
    color: var(--text); margin: 0; padding: 18px; min-height: 100vh;
  }
  .top { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
  h1 { font-size: 17px; font-weight:600; margin:0; letter-spacing:0.2px; }
  .badge { background:#3a1d00; color:var(--amber); border:1px solid #5c3400; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:600; letter-spacing:0.4px; }
  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--up); margin-right:6px; animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%{opacity:1} 50%{opacity:0.25} 100%{opacity:1} }

  .instance-block { border-radius:18px; padding:16px; margin-bottom:28px; border:1px solid var(--border); background: linear-gradient(180deg, rgba(255,255,255,0.015), transparent 120px); }
  .instance-head { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .instance-dot { width:11px; height:11px; border-radius:50%; box-shadow: 0 0 10px 1px currentColor; }
  .instance-title { font-size:15px; font-weight:700; letter-spacing:0.3px; }
  .instance-sub { font-size:11px; color:var(--muted); }

  .summary { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap:10px; margin-bottom:16px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:12px 14px; box-shadow:var(--shadow); }
  .card .label { font-size:10.5px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
  .card .val { font-size:19px; font-weight:700; }
  .pnl-pos { color:var(--up); } .pnl-neg { color:var(--down); }

  .section-title { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.6px; margin: 18px 0 8px; }

  .markets { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); gap:12px; }
  .mcard { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:14px; box-shadow:var(--shadow); }
  .mcard .mhead { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; }
  .mcard .mhead .asset { font-size:15px; font-weight:700; }
  .mcard .mhead .timer { font-variant-numeric: tabular-nums; font-size:12.5px; color:var(--amber); font-weight:600; }
  .outrow { display:flex; align-items:center; gap:10px; margin: 7px 0; }
  .outlabel { width:48px; font-weight:700; font-size:12.5px; }
  .outlabel.up { color:var(--up); } .outlabel.down { color:var(--down); }
  .barwrap { flex:1; height: 20px; background:#0d1219; border-radius:6px; overflow:hidden; border:1px solid var(--border); position:relative; }
  .bar { height:100%; transition: width .4s ease; }
  .bar.up { background: linear-gradient(90deg, #0f4a30, var(--up)); }
  .bar.down { background: linear-gradient(90deg, #4a0f22, var(--down)); }
  .barval { position:absolute; right:6px; top:0; bottom:0; display:flex; align-items:center; font-size:11.5px; font-weight:700; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
  .subprices { width:140px; text-align:right; font-size:10.5px; color:var(--muted); font-variant-numeric: tabular-nums; }

  .pairs { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); gap:12px; }
  .pcard { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:14px; box-shadow:var(--shadow); }
  .pcard.fired { border-color: #2a5c3f; box-shadow: 0 0 0 1px #2a5c3f inset; }
  .pcard.locked { opacity: 0.55; }
  .pcard .phead { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .pcard .pname { font-weight:700; font-size:12.5px; }
  .chip { font-size:9.5px; padding:2px 8px; border-radius:20px; font-weight:700; letter-spacing:0.3px; }
  .chip.armed { background:#1c2430; color:var(--muted); }
  .chip.fired-chip { background:#123424; color:var(--up); border:1px solid #1e5c3d; }
  .chip.locked-chip { background:#2a1414; color:var(--down); border:1px solid #4a1e1e; }
  .chip.notp-chip { background:#1e2a3a; color:var(--accent); border:1px solid #2c4a6b; }
  .prow { display:flex; justify-content:space-between; font-size:11.5px; color:var(--muted); margin:4px 0; }
  .prow b { color: var(--text); font-variant-numeric: tabular-nums; }
  .threshbar { height:7px; border-radius:4px; background:#0d1219; border:1px solid var(--border); margin-top:8px; position:relative; overflow:hidden; }
  .threshfill { height:100%; background: linear-gradient(90deg, var(--accent), var(--up)); }

  .pos { border-left:3px solid var(--accent); margin:7px 0; padding:9px 11px; background:var(--panel2); border-radius:8px; font-size:12.5px; }
  .pos .row { display:flex; justify-content:space-between; }
  .empty { color: var(--muted); font-size: 12.5px; padding: 8px 0; }

  table { width:100%; border-collapse: collapse; font-size: 12px; background:var(--panel); border-radius:12px; overflow:hidden; }
  td, th { padding:7px 9px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:10px; letter-spacing:0.4px; }
  tr:last-child td { border-bottom:none; }

  .footer { color: var(--muted); font-size: 10.5px; margin-top:10px; text-align:right; }
</style>
</head>
<body>
  <div class="top">
    <h1><span class="pulse"></span>Polymarket Cross-Market Bot — 5m &amp; 15m (independent instances)</h1>
    <span class="badge">PAPER / DEMO MODE — NO REAL ORDERS</span>
  </div>

  <div id="panels"></div>

<script>
function fmt(n, d=3) { return (n === null || n === undefined) ? '&mdash;' : Number(n).toFixed(d); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function mmss(s) { s = Math.max(0, Math.floor(s)); const m = Math.floor(s/60); const r = s%60; return m + ':' + String(r).padStart(2,'0'); }

const INSTANCE_META = {
  '5m':  { color: 'var(--c5m)',  title: '5-Minute Windows' },
  '15m': { color: 'var(--c15m)', title: '15-Minute Windows' },
};

function renderPanel(label, d) {
  const meta = INSTANCE_META[label] || { color: 'var(--accent)', title: label };
  const totalPnl = (d.equity ?? 0) - (d.starting_capital ?? 0);

  const summary = `
    <div class="card"><div class="label">Status</div><div class="val">${d.status ?? '-'}</div></div>
    <div class="card"><div class="label">Cash balance</div><div class="val">$${fmt(d.balance_cash,2)}</div></div>
    <div class="card"><div class="label">Equity (mark-to-market)</div><div class="val ${totalPnl>=0?'pnl-pos':'pnl-neg'}">$${fmt(d.equity,2)}</div></div>
    <div class="card"><div class="label">Starting capital</div><div class="val">$${fmt(d.starting_capital,2)}</div></div>
    <div class="card"><div class="label">Total P&amp;L</div><div class="val ${totalPnl>=0?'pnl-pos':'pnl-neg'}">${totalPnl>=0?'+':''}$${fmt(totalPnl,2)}</div></div>
    <div class="card"><div class="label">Shares/leg this window</div><div class="val" style="${d.sizing?.current_window_shares_per_leg === d.sizing?.boosted_shares_per_leg ? 'color:var(--amber)' : ''}">${d.sizing?.current_window_shares_per_leg ?? '-'}</div></div>
    <div class="card"><div class="label">Boost armed (next window)</div><div class="val" style="${d.sizing?.boost_armed_for_next_window ? 'color:var(--amber)' : ''}">${d.sizing?.boost_armed_for_next_window ? 'YES' : 'no'}</div></div>
  `;

  const markets = d.markets || {};
  const marketsHtml = Object.entries(markets).map(([asset, m]) => {
    const rows = Object.entries(m.outcomes || {}).map(([name, o]) => {
      const isUp = name.toLowerCase() === 'up';
      const mid = o.mid ?? 0;
      const w = clamp(mid*100, 2, 100);
      return `
        <div class="outrow">
          <div class="outlabel ${isUp?'up':'down'}">${name}</div>
          <div class="barwrap"><div class="bar ${isUp?'up':'down'}" style="width:${w}%"></div>
            <div class="barval">${fmt(o.mid,3)}</div>
          </div>
          <div class="subprices">bid ${fmt(o.best_bid,3)} / ask ${fmt(o.best_ask,3)}</div>
        </div>`;
    }).join('');
    return `
      <div class="mcard">
        <div class="mhead">
          <span class="asset">${asset.toUpperCase()}</span>
          <span class="timer">${mmss(m.seconds_left)} left &middot; ${m.slug}</span>
        </div>
        ${rows || '<div class="empty">waiting for order book&hellip;</div>'}
      </div>`;
  }).join('') || '<div class="empty">discovering current window&hellip;</div>';

  const pairs = d.pairs || {};
  const pairsHtml = Object.entries(pairs).map(([pid, p]) => {
    const state = p.state || 'ARMED';
    const ask = p.combined_ask, bid = p.combined_bid;
    const entryT = (d.config?.entry_combined_price) ?? 0.85;
    const exitT = (d.config?.exit_combined_price) ?? 1.15;
    const cardClass = state === 'ARMED' ? '' : 'fired';
    const chipMap = {
      ARMED: ['armed', 'ARMED'],
      HOLDING_TP: ['fired-chip', 'HOLDING (TP armed)'],
      HOLDING_NO_TP: ['notp-chip', 'HOLDING (no TP)'],
      LOCKED: ['locked-chip', 'LOCKED (TP hit)'],
    };
    const [chipClass, chipLabel] = chipMap[state] || chipMap.ARMED;
    let fillPct, fillLabel;
    if (state === 'HOLDING_TP') {
      fillPct = clamp(((bid ?? entryT) - entryT) / (exitT - entryT) * 100, 0, 100);
      fillLabel = `first to fire this window &middot; bid ${fmt(bid)} &rarr; take-profit at ${exitT}`;
    } else if (state === 'HOLDING_NO_TP') {
      fillPct = 100;
      fillLabel = `fired second this window &middot; no take-profit &middot; holding to resolution`;
    } else if (state === 'LOCKED') {
      fillPct = 100;
      fillLabel = `take-profit already hit this window &middot; locked, no re-entry`;
    } else {
      fillPct = clamp((1 - clamp((ask ?? entryT), 0, entryT*2) / entryT) * 100, 0, 100);
      fillLabel = `ask ${fmt(ask)} &rarr; fires below ${entryT}`;
    }
    return `
      <div class="pcard ${cardClass}">
        <div class="phead">
          <span class="pname">${pid.replace(/_/g,' ')}</span>
          <span class="chip ${chipClass}">${chipLabel}</span>
        </div>
        <div class="prow"><span>Combined ask (entry cost)</span><b>${fmt(ask)}</b></div>
        <div class="prow"><span>Combined bid (mark / exit value)</span><b>${fmt(bid)}</b></div>
        <div class="prow"><span>${state === 'HOLDING_TP' ? 'Distance to take-profit' : 'Distance to entry'}</span>
          <b>${state === 'HOLDING_TP' ? fmt(p.distance_to_exit) : fmt(p.distance_to_entry)}</b></div>
        <div class="threshbar"><div class="threshfill" style="width:${fillPct}%"></div></div>
        <div class="prow" style="margin-top:4px;font-size:10px;">${fillLabel}</div>
      </div>`;
  }).join('') || '<div class="empty">waiting for window discovery&hellip;</div>';

  const openHtml = (d.open_positions||[]).map(p => `
    <div class="pos">
      <div class="row"><b>${p.pair_id.replace(/_/g,' ')}</b><span>window ${p.window_start} &middot; ${p.shares_per_leg ?? '?'} sh/leg</span></div>
      <div class="row"><span>cost $${fmt(p.entry_cost,2)} + fee $${fmt(p.entry_fees,3)}</span>
      <span class="${(p.unrealized_pnl||0)>=0?'pnl-pos':'pnl-neg'}">unrealized ${(p.unrealized_pnl||0)>=0?'+':''}$${fmt(p.unrealized_pnl,3)}</span></div>
    </div>`).join('') || '<div class="empty">No open positions right now.</div>';

  const awaitingHtml = (d.awaiting_resolution||[]).map(p => `
    <div class="pos" style="border-left-color:var(--amber);">
      <div class="row"><b>${p.pair_id.replace(/_/g,' ')}</b><span>window ${p.window_start} &middot; ${p.shares_per_leg ?? '?'} sh/leg</span></div>
      <div class="row"><span>cost $${fmt(p.entry_cost,2)}</span><span>waiting for CLOB price to confirm&hellip;</span></div>
    </div>`).join('') || '<div class="empty">Nothing awaiting resolution.</div>';

  const recentHtml = (d.recent_trades||[]).map(t => `
    <tr><td>${t.id}</td><td>${t.pair_id.replace(/_/g,' ')}${t.decorrelated ? ' <span style=\"color:var(--down);font-size:10px;\">(decorrelated)</span>' : ''}</td><td>${t.status}</td>
    <td class="${(t.realized_pnl||0)>=0?'pnl-pos':'pnl-neg'}">${(t.realized_pnl||0)>=0?'+':''}$${fmt(t.realized_pnl,3)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">No trades yet.</td></tr>';

  return `
    <div class="instance-block" style="border-color:${meta.color}44;">
      <div class="instance-head" style="color:${meta.color};">
        <span class="instance-dot" style="background:${meta.color};color:${meta.color};"></span>
        <span class="instance-title">${meta.title}</span>
        <span class="instance-sub">&middot; independent bankroll, positions, and log stream</span>
      </div>
      <div class="summary">${summary}</div>
      <div class="section-title">Live Market — BTC &amp; ETH Up/Down (current window)</div>
      <div class="markets">${marketsHtml}</div>
      <div class="section-title">Cross-Market Pairs</div>
      <div class="pairs">${pairsHtml}</div>
      <div class="section-title">Open Positions</div>
      <div>${openHtml}</div>
      <div class="section-title">Awaiting Resolution</div>
      <div>${awaitingHtml}</div>
      <div class="section-title">Recent Trades</div>
      <table><thead><tr><th>ID</th><th>Pair</th><th>Status</th><th>PnL</th></tr></thead><tbody>${recentHtml}</tbody></table>
      <div class="footer">tick #${d.tick} &middot; updated ${new Date().toLocaleTimeString()}</div>
    </div>`;
}

async function refresh() {
  let all;
  try {
    const r = await fetch('/status');
    all = await r.json();
  } catch (e) { return; }
  if (!all || all.status === 'not started') return;

  const order = ['5m', '15m'];
  const labels = order.filter(l => all[l]).concat(Object.keys(all).filter(l => !order.includes(l)));
  document.getElementById('panels').innerHTML = labels.map(label => renderPanel(label, all[label])).join('');
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return DASHBOARD_HTML
