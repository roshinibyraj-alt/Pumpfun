function fmtSecs(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function fmtMoney(v) {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}
function fmtPrice(v) {
  return v === null || v === undefined ? '—' : v.toFixed(3);
}
function timeAgo(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour12: false });
}

function orderBadge(order) {
  if (order.status === 'FILLED') {
    return `<span class="badge filled ${order.side.toLowerCase()}">FILLED @ ${order.fill_price.toFixed(2)}</span>`;
  }
  if (order.status === 'CANCELLED') {
    return `<span class="badge cancelled">CANCELLED</span>`;
  }
  return `<span class="badge pending">RESTING</span>`;
}

function renderRungs(snap) {
  const board = document.getElementById('rungBoard');
  const win = snap.active_windows.find(w => w.slug === snap.current_window.slug) || snap.active_windows[0];

  board.innerHTML = snap.rungs.map(r => {
    const priceKey = r.price.toFixed(2);
    const rungOrders = win ? win.rungs[priceKey] : null;

    let orderHtml = `<div class="orderline"><span class="side up">UP</span><span class="badge">—</span></div>
                      <div class="orderline"><span class="side down">DOWN</span><span class="badge">—</span></div>`;
    if (rungOrders) {
      orderHtml = `
        <div class="orderline"><span class="side up">UP</span>${orderBadge(rungOrders.up)}</div>
        <div class="orderline"><span class="side down">DOWN</span>${orderBadge(rungOrders.down)}</div>`;
    }

    const pnlClass = r.total_pnl > 0 ? 'pos' : (r.total_pnl < 0 ? 'neg' : '');
    const balClass = r.capital_balance > r.capital_start ? 'pos' : (r.capital_balance < r.capital_start ? 'neg' : '');

    return `
      <div class="rung">
        <div class="price-row">
          <div class="price mono">${priceKey}</div>
          <div class="streak">streak <b>${r.win_streak}</b></div>
        </div>
        <div class="size-block mono">
          <div class="now">${r.current_size} sh</div>
          <div class="next">next on win<br>${r.next_size_if_win} sh</div>
        </div>
        ${orderHtml}
        <div class="stats mono">
          <div class="stat"><div class="k">WIN RATE</div><div class="v">${r.win_rate}%</div></div>
          <div class="stat"><div class="k">TRADES</div><div class="v">${r.total_trades}</div></div>
          <div class="stat"><div class="k">W / L / NF</div><div class="v">${r.wins}/${r.losses}/${r.no_fills}</div></div>
          <div class="stat"><div class="k">PNL</div><div class="v ${pnlClass}">${fmtMoney(r.total_pnl)}</div></div>
          <div class="stat" style="grid-column:1/-1"><div class="k">BANKROLL ($${r.capital_start} start)</div><div class="v ${balClass}">${fmtMoney(r.capital_balance)}</div></div>
        </div>
      </div>`;
  }).join('');
}

function renderAgg(snap) {
  const a = snap.aggregate;
  const el = document.getElementById('aggStrip');
  const pnlClass = a.total_pnl > 0 ? 'pos' : (a.total_pnl < 0 ? 'neg' : '');
  const roiClass = a.roi_pct > 0 ? 'pos' : (a.roi_pct < 0 ? 'neg' : '');
  el.innerHTML = `
    <div class="cell"><div class="label">TOTAL BANKROLL</div><div class="value">${fmtMoney(a.total_capital)}</div></div>
    <div class="cell"><div class="label">TOTAL PNL</div><div class="value ${pnlClass}">${fmtMoney(a.total_pnl)}</div></div>
    <div class="cell"><div class="label">ROI</div><div class="value ${roiClass}">${a.roi_pct > 0 ? '+' : ''}${a.roi_pct}%</div></div>
    <div class="cell"><div class="label">TRADES / WIN RATE</div><div class="value">${a.total_trades} · ${a.win_rate}%</div></div>
  `;
}

function renderTicker(snap) {
  document.getElementById('tWindow').textContent = snap.current_window.slug.replace('btc-updown-5m-', '#');
  document.getElementById('tWindowRemaining').textContent = fmtSecs(snap.current_window.window_remaining);
  const cutoffEl = document.getElementById('tCutoff');
  cutoffEl.textContent = snap.current_window.past_cutoff ? 'CLOSED' : fmtSecs(snap.current_window.cutoff_remaining);
  cutoffEl.className = 'value ' + (snap.current_window.past_cutoff ? 'warn' : (snap.current_window.cutoff_remaining < 30 ? 'warn' : ''));

  const win = snap.active_windows.find(w => w.slug === snap.current_window.slug);
  document.getElementById('tUpPrice').textContent = win ? fmtPrice(win.last_up_price) : '—';
  document.getElementById('tDownPrice').textContent = win ? fmtPrice(win.last_down_price) : '—';
}

function renderLog(snap) {
  const body = document.getElementById('logBody');
  body.innerHTML = snap.recent_trades.map(t => `
    <tr>
      <td>${timeAgo(t.settled_at)}</td>
      <td>${t.window_slug.replace('btc-updown-5m-', '#')}</td>
      <td>${t.rung_price.toFixed(2)}</td>
      <td>${t.side_filled ? `<span class="${t.side_filled === 'UP' ? 'up' : 'down'}">${t.side_filled}</span>` : '—'}</td>
      <td>${t.size}</td>
      <td>${fmtMoney(t.cost)}</td>
      <td><span class="tag ${t.outcome}">${t.outcome}</span></td>
      <td class="${t.pnl > 0 ? 'up' : (t.pnl < 0 ? 'down' : '')}">${fmtMoney(t.pnl)}</td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="color:var(--muted)">No settlements yet.</td></tr>`;
}

function renderEvents(snap) {
  const body = document.getElementById('eventsBody');
  const rows = [...snap.events].reverse();
  body.innerHTML = rows.map(e => `
    <div class="event-row ${e.level === 'error' ? 'error' : ''}">
      <span class="t mono">${timeAgo(e.ts)}</span><span>${e.text}</span>
    </div>
  `).join('') || `<div class="event-row">No events yet.</div>`;
}

function render(snap) {
  document.getElementById('modePill').textContent = snap.mode;
  renderTicker(snap);
  renderRungs(snap);
  renderAgg(snap);
  renderLog(snap);
  renderEvents(snap);
  document.getElementById('footUptime').textContent = `uptime ${fmtSecs(snap.uptime_seconds)}`;
}

function setConn(state) {
  const el = document.getElementById('connStatus');
  const txt = document.getElementById('connText');
  el.className = 'conn ' + state;
  txt.textContent = state === 'live' ? 'live' : (state === 'down' ? 'disconnected — retrying' : 'connecting…');
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setConn('live');
  ws.onmessage = (ev) => render(JSON.parse(ev.data));
  ws.onclose = () => { setConn('down'); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}
connect();
