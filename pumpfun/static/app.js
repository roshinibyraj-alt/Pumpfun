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

function pnlClass(v) { return v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : 'flat'); }
function pnlSign(v) { return v > 0.004 ? '+' : ''; }

function renderPositions(snap) {
  const wrap = document.getElementById('positionsWrap');
  const countEl = document.getElementById('posCount');
  const positions = snap.open_positions || [];
  countEl.textContent = positions.length ? `${positions.length} open` : '';

  if (!positions.length) {
    wrap.innerHTML = `<div class="positions-empty">No open positions right now — all rungs are either resting orders or flat.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="positions-grid">${positions.map(p => {
    const cls = pnlClass(p.unrealized_pnl);
    const sideCls = p.side === 'UP' ? 'side-up' : 'side-down';
    return `
      <div class="position-card ${sideCls} pulse" data-key="${p.window_slug}-${p.rung_price}">
        <div class="prow">
          <span class="rung-tag mono">${p.strategy === 'weekend' ? 'weekend' : 'weekday'} · rung ${p.rung_price.toFixed(2)} · pair ${p.capital_pair.toFixed(2)}</span>
          <span class="side-tag ${p.side.toLowerCase()}">${p.side}</span>
        </div>
        <div class="pnl-row">
          <span class="pnl-label">FLOATING P&amp;L</span>
          <span class="pnl-value ${cls}">${pnlSign(p.unrealized_pnl)}${fmtMoney(p.unrealized_pnl)}</span>
        </div>
        <div class="sub-row">
          <span>${p.size} sh @ <b>${p.entry_price.toFixed(2)}</b></span>
          <span>mark <b>${fmtPrice(p.mark_price)}</b></span>
          <span>closes ${fmtSecs(p.window_remaining)}</span>
        </div>
        <div class="position-cost-note">fee ${fmtMoney(p.fee_usd)} · rebate estimate ${fmtMoney(p.maker_rebate_estimate)}</div>
      </div>`;
  }).join('')}</div>`;
}

function renderStrategy(strategyKey, snap) {
  const strategy = snap.strategies[strategyKey];
  const isWeekend = strategyKey === 'weekend';
  const board = document.getElementById(`${strategyKey}Rungs`);
  const card = document.getElementById(`${strategyKey}Card`);
  const stateEl = document.getElementById(`${strategyKey}State`);
  const win = snap.active_windows.find(
    w => w.slug === snap.current_window.slug && w.strategy === strategyKey,
  );

  card.classList.toggle('inactive', !strategy.active);
  stateEl.className = `rung-session-state ${strategy.active ? 'active' : 'inactive'}`;
  stateEl.textContent = strategy.active ? 'ACTIVE NOW' : 'INACTIVE';
  document.getElementById(`${strategyKey}Summary`).innerHTML = `
    <span><small>NET REALIZED</small> <b class="${pnlClass(strategy.realized_pnl)}">${pnlSign(strategy.realized_pnl)}${fmtMoney(strategy.realized_pnl)}</b></span>
    <span><small>RECORD / WIN RATE</small> <b>${strategy.wins}W · ${strategy.losses}L · ${strategy.win_rate}%</b></span>
    <span><small>FEES PAID</small> <b>${fmtMoney(strategy.fees_paid)}</b></span>
    <span><small>REBATE EST.</small> <b>${fmtMoney(strategy.maker_rebate_estimate)}</b></span>
  `;

  board.innerHTML = strategy.rungs.map(r => {
    const priceKey = r.price.toFixed(2);
    const rungData = win ? win.rungs[priceKey] : null;
    const position = rungData ? rungData.position : null;

    let statusHtml;
    let stateClass = '';
    if (position) {
      const sideCls = position.side.toLowerCase();
      stateClass = `state-position side-${sideCls}`;
      statusHtml = `
        <div class="status-position">
          <span class="side-badge ${sideCls}">${position.side}</span>
          <span class="entry">${isWeekend ? 'market buy' : 'maker fill'} @ ${position.entry_price.toFixed(3)}</span>
          <span class="arrow">→</span>
          <span class="mark">mark ${fmtPrice(position.mark_price)}</span>
        </div>`;
    } else if (rungData) {
      const makeChip = (side, order) => {
        if (order.status === 'CANCELLED') {
          return `<span class="order-chip cancelled">${side} cancelled</span>`;
        }
        if (order.status === 'FILLED') {
          return `<span class="order-chip filled ${side.toLowerCase()}">${side} filled</span>`;
        }
        const trigger = isWeekend
          ? `${side} buy trigger ≥ ${priceKey}`
          : `${side} limit ≤ ${priceKey}`;
        return `<span class="order-chip resting ${side.toLowerCase()}"><span class="dot"></span>${trigger}</span>`;
      };
      statusHtml = `<div class="status-resting">${makeChip('UP', rungData.up)}${makeChip('DOWN', rungData.down)}</div>`;
    } else if (!strategy.active) {
      statusHtml = `<span class="status-idle">session inactive — no new orders</span>`;
    } else {
      statusHtml = `<span class="status-idle">waiting for window to open…</span>`;
    }

    const realizedPnl = r.total_pnl;
    const unrealizedPnl = r.unrealized_pnl ?? 0;

    return `
      <div class="rung ${stateClass}">
        <div class="price-col">
          <div class="price">${priceKey}</div>
          <div class="streak">pair ${r.pair_price.toFixed(2)} · win streak <b>${r.win_streak}</b></div>
          <div class="rung-record">record ${r.wins}W–${r.losses}L · win rate <b>${r.win_rate}%</b> (${r.total_trades} trades)</div>
        </div>
        <div class="status-col">${statusHtml}</div>
        <div class="size-col">
          <span class="size-now">${r.current_size}<span style="font-size:11px;color:var(--muted)">&nbsp;sh</span></span>
          <span class="size-arrow">→</span>
          <span class="size-next">${r.next_size_if_win} sh on win</span>
        </div>
        <div class="pnl-col">
          <div class="metric-row"><span>REALIZED NET</span><b class="${pnlClass(realizedPnl)}">${pnlSign(realizedPnl)}${fmtMoney(realizedPnl)}</b></div>
          <div class="metric-row"><span>UNREALIZED</span><b class="${pnlClass(unrealizedPnl)}">${pnlSign(unrealizedPnl)}${fmtMoney(unrealizedPnl)}</b></div>
          <div class="meta">PAIR CAPITAL (${r.pair_price.toFixed(2)}) <b>${fmtMoney(r.capital_balance)} / ${fmtMoney(r.capital_start)} start</b></div>
          <div class="meta">fees ${fmtMoney(r.total_fees_paid)} · rebate est. ${fmtMoney(r.total_maker_rebate_estimate)}</div>
        </div>
      </div>`;
  }).join('');
}

function renderAgg(snap) {
  const a = snap.aggregate;
  const el = document.getElementById('aggStrip');
  const realClass = pnlClass(a.realized_pnl);
  const floatClass = pnlClass(a.floating_pnl);
  const combClass = pnlClass(a.combined_pnl);
  const combinedCapital = a.combined_capital ?? (a.total_capital + a.floating_pnl);
  el.innerHTML = `
    <div class="cell"><div class="label">COMBINED CAPITAL</div><div class="value">${fmtMoney(combinedCapital)}</div><div class="agg-note">cash ${fmtMoney(a.total_capital)} · start ${fmtMoney(a.total_start_capital)}</div></div>
    <div class="cell"><div class="label">REALIZED P&amp;L</div><div class="value ${realClass}">${pnlSign(a.realized_pnl)}${fmtMoney(a.realized_pnl)}</div></div>
    <div class="cell"><div class="label">FLOATING P&amp;L</div><div class="value ${floatClass}">${pnlSign(a.floating_pnl)}${fmtMoney(a.floating_pnl)}</div></div>
    <div class="cell"><div class="label">COMBINED P&amp;L · ROI</div><div class="value ${combClass}">${pnlSign(a.combined_pnl)}${fmtMoney(a.combined_pnl)} <span style="font-size:13px">(${a.roi_pct > 0 ? '+' : ''}${a.roi_pct}%)</span></div></div>
    <div class="cell"><div class="label">TRADES / WIN RATE</div><div class="value">${a.total_trades} · ${a.win_rate}%</div></div>
  `;
}

function renderTicker(snap) {
  document.getElementById('tWindow').textContent = snap.current_window.slug.replace('btc-updown-5m-', '#');
  document.getElementById('tWindowRemaining').textContent = fmtSecs(snap.current_window.window_remaining);
  const cutoffEl = document.getElementById('tCutoff');
  const inactive = !snap.current_window.strategy;
  cutoffEl.textContent = inactive
    ? 'INACTIVE'
    : (snap.current_window.past_cutoff ? 'CLOSED' : fmtSecs(snap.current_window.cutoff_remaining));
  cutoffEl.className = 'value ' + (inactive || snap.current_window.past_cutoff ? 'warn' : (snap.current_window.cutoff_remaining < 30 ? 'warn' : ''));

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
      <td>${t.strategy === 'weekend' ? 'WEEKEND' : 'WEEKDAY'}</td>
      <td>${t.rung_price.toFixed(2)}</td>
      <td>${t.side_filled ? `<span class="${t.side_filled === 'UP' ? 'up' : 'down'}">${t.side_filled}</span>` : '—'}</td>
      <td>${t.size}</td>
      <td>${fmtMoney(t.cost)}</td>
      <td>${fmtMoney(t.fee_usd)}</td>
      <td>${fmtMoney(t.maker_rebate_estimate)}</td>
      <td><span class="tag ${t.outcome}">${t.outcome}</span></td>
      <td class="${t.pnl > 0 ? 'up' : (t.pnl < 0 ? 'down' : '')}">${fmtMoney(t.pnl)}</td>
    </tr>
  `).join('') || `<tr><td colspan="11" style="color:var(--muted)">No settlements yet.</td></tr>`;
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
  renderPositions(snap);
  renderStrategy('weekday', snap);
  renderStrategy('weekend', snap);
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
