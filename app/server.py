from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

from .strategy import Bot

app = FastAPI(title="Polymarket 5m Cross-Market Bot (paper)")
bot: Bot = None  # set by main.py


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/status")
async def status():
    if bot is None:
        return JSONResponse({"status": "not started"}, status_code=503)
    return bot.status()


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return """
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Polymarket 5m Cross-Market Bot (PAPER)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0b0f14; color:#e6edf3; margin:0; padding:16px; }
  h1 { font-size: 18px; }
  .badge { background:#5b2b00; color:#ffb86c; padding:2px 8px; border-radius:6px; font-size:12px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap:12px; margin:12px 0; }
  .card { background:#131a22; border:1px solid #223; border-radius:10px; padding:12px; }
  .card .v { font-size:22px; font-weight:600; }
  .pos { border-left:3px solid #58a6ff; margin:8px 0; padding:8px; background:#101820; border-radius:6px; }
  .pnl-pos { color:#3fb950; } .pnl-neg { color:#f85149; }
  table { width:100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding:4px 6px; text-align:left; border-bottom:1px solid #223; }
  pre { white-space: pre-wrap; font-size:12px; color:#8b949e; }
</style>
</head>
<body>
  <h1>Polymarket 5-Minute Cross-Market Bot <span class="badge">PAPER / DEMO MODE</span></h1>
  <div class="grid" id="summary"></div>
  <h3>Open positions</h3>
  <div id="open"></div>
  <h3>Awaiting resolution</h3>
  <div id="awaiting"></div>
  <h3>Recent trades</h3>
  <table id="recent"><thead><tr><th>ID</th><th>Pair</th><th>Status</th><th>PnL</th></tr></thead><tbody></tbody></table>
<script>
async function refresh() {
  const r = await fetch('/status');
  const d = await r.json();
  document.getElementById('summary').innerHTML = `
    <div class="card"><div>Status</div><div class="v">${d.status ?? '-'}</div></div>
    <div class="card"><div>Cash balance</div><div class="v">$${(d.balance_cash ?? 0).toFixed(2)}</div></div>
    <div class="card"><div>Equity (mark-to-market)</div><div class="v">$${(d.equity ?? 0).toFixed(2)}</div></div>
    <div class="card"><div>Starting capital</div><div class="v">$${(d.starting_capital ?? 0).toFixed(2)}</div></div>
  `;
  document.getElementById('open').innerHTML = (d.open_positions||[]).map(p => `
    <div class="pos">
      <b>${p.pair_id}</b> window ${p.window_start} — cost $${p.entry_cost} + fee $${p.entry_fees}
      — unrealized: <span class="${(p.unrealized_pnl||0)>=0?'pnl-pos':'pnl-neg'}">$${p.unrealized_pnl ?? 'n/a'}</span>
    </div>`).join('') || '<i>none</i>';
  document.getElementById('awaiting').innerHTML = (d.awaiting_resolution||[]).map(p => `
    <div class="pos">${p.pair_id} window ${p.window_start} — cost $${p.entry_cost}</div>`).join('') || '<i>none</i>';
  document.querySelector('#recent tbody').innerHTML = (d.recent_trades||[]).map(t => `
    <tr><td>${t.id}</td><td>${t.pair_id}</td><td>${t.status}</td>
    <td class="${(t.realized_pnl||0)>=0?'pnl-pos':'pnl-neg'}">$${t.realized_pnl ?? '-'}</td></tr>`).join('');
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
"""
