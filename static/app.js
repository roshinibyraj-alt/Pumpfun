function fmtMoney(v) {
  if (v === null || v === undefined) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return `${sign}$${abs.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}
function fmtMoneyShort(v) {
  if (v === null || v === undefined) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign}$${(abs/1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}
function fmtPrice(v) { return v === null || v === undefined ? '—' : v.toFixed(3); }
function fmtShares(v) { return v === null || v === undefined ? '—' : v.toLocaleString(undefined, {maximumFractionDigits: 1}); }
function fmtSecs(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}
function timeAgo(ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour12: false }); }
function pnlClass(v) { return v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : 'flat'); }
function pnlSign(v) { return v > 0.004 ? '+' : ''; }
function shortAddr(a) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : '—'; }

const ACCENTS = ['cyan', 'violet', 'emerald', 'amber', 'rose', 'gold'];
function accentFor(tokenId) {
  let hash = 0;
  for (let i = 0; i < tokenId.length; i++) hash = (hash * 31 + tokenId.charCodeAt(i)) >>> 0;
  return `var(--${ACCENTS[hash % ACCENTS.length]})`;
}

function renderHero(snap) {
  const cr = snap.capital_required;
  const demoCapital = snap.config.demo_capital;
  const idealPeak = cr.ideal_peak_deployed;

  document.getElementById('heroAmount').textContent = fmtMoney(idealPeak);
  const verdictEl = document.getElementById('heroVerdict');
  if (cr.sufficiently_capitalized) {
    verdictEl.className = 'verdict ok';
    verdictEl.textContent = `✓ covered by the ${fmtMoneyShort(demoCapital)} demo account`;
  } else {
    verdictEl.className = 'verdict short';
    verdictEl.textContent = `needs ${fmtMoney(cr.shortfall_vs_demo)} more than the demo account has`;
  }

  const noteEl = document.getElementById('heroNote');
  if (!snap.bootstrapped) {
    noteEl.textContent = 'Bootstrapping — copying the master wallet\'s current open positions now.';
  } else if (cr.total_buy_signals === 0) {
    noteEl.textContent = 'No buy signals copied yet — this fills in as the master wallet trades.';
  } else {
    noteEl.textContent = `Based on ${cr.total_buy_signals} buy signal${cr.total_buy_signals===1?'':'s'} copied so far at ${(snap.config.copy_ratio*100).toFixed(0)}% size — this is the peak amount that was ever committed at once, uncapped by the $${demoCapital.toLocaleString()} demo limit.`;
  }

  const scaleMax = Math.max(idealPeak, demoCapital, 1) * 1.15;
  const fillPct = Math.min(100, (idealPeak / scaleMax) * 100);
  const markerPct = Math.min(100, (demoCapital / scaleMax) * 100);
  const fillEl = document.getElementById('gaugeFill');
  fillEl.style.width = fillPct + '%';
  fillEl.className = 'gauge-fill' + (idealPeak > demoCapital ? ' over' : '');
  const markerEl = document.getElementById('gaugeMarker');
  markerEl.style.left = markerPct + '%';
  document.getElementById('gaugeMax').textContent = fmtMoney(scaleMax);

  document.getElementById('heroSubstats').innerHTML = `
    <div class="cell"><div class="k">MAX SPENT IN A SINGLE TRADE</div><div class="v">${fmtMoney(cr.max_trade_cost)}</div></div>
    <div class="cell"><div class="k">MIN SPENT IN A SINGLE TRADE</div><div class="v">${fmtMoney(cr.min_trade_cost)}</div></div>
    <div class="cell"><div class="k">AVG SPENT PER TRADE</div><div class="v">${fmtMoney(cr.avg_trade_cost)}</div></div>
    <div class="cell"><div class="k">BUY SIGNALS COPIED</div><div class="v">${cr.total_buy_signals}</div></div>
  `;
}

function renderStrip(snap) {
  const l = snap.ledger;
  const el = document.getElementById('portfolioStrip');
  el.innerHTML = `
    <div class="cell"><div class="label">CASH AVAILABLE</div><div class="value">${fmtMoney(l.cash_balance)}</div></div>
    <div class="cell"><div class="label">CAPITAL DEPLOYED NOW</div><div class="value">${fmtMoney(l.capital_deployed)}</div></div>
    <div class="cell"><div class="label">PEAK CAPITAL USED (demo)</div><div class="value">${fmtMoney(l.peak_capital_deployed)}</div></div>
    <div class="cell"><div class="label">COMBINED P&amp;L · ROI</div><div class="value ${pnlClass(l.combined_pnl)}">${pnlSign(l.combined_pnl)}${fmtMoney(l.combined_pnl)} <span style="font-size:13px">(${l.roi_pct>0?'+':''}${l.roi_pct}%)</span></div></div>
  `;
}

function renderPositions(snap) {
  const wrap = document.getElementById('positionsWrap');
  const countEl = document.getElementById('posCount');
  const positions = snap.positions || [];
  countEl.textContent = positions.length ? `${positions.length} open` : '';

  if (!positions.length) {
    wrap.innerHTML = `<div class="positions-empty">No open copied positions yet.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="positions-grid">${positions.map(p => {
    const accent = accentFor(p.token_id);
    const cls = pnlClass(p.unrealized_pnl);
    const ratio = p.master_size_at_last_sync > 0 ? (p.our_size / p.master_size_at_last_sync * 100) : null;
    return `
      <div class="pos-card" style="--accent:${accent}">
        <div class="title">${p.market_title}</div>
        <span class="outcome">${p.outcome_label}</span>
        <div class="pnl-row">
          <span class="pnl-label">FLOATING P&amp;L</span>
          <span class="pnl-value ${cls}">${pnlSign(p.unrealized_pnl)}${fmtMoney(p.unrealized_pnl)}</span>
        </div>
        <div class="meta-grid">
          <div>our size <b>${fmtShares(p.our_size)}</b> sh</div>
          <div>avg entry <b>${fmtPrice(p.avg_entry_price)}</b></div>
          <div>mark <b>${fmtPrice(p.mark_price)}</b></div>
          <div>cost basis <b>${fmtMoney(p.cost_basis)}</b></div>
        </div>
        ${ratio !== null ? `<div class="ratio-note">tracking ${ratio.toFixed(1)}% of master's ${fmtShares(p.master_size_at_last_sync)} sh</div>` : ''}
      </div>`;
  }).join('')}</div>`;
}

function renderFeed(snap) {
  const body = document.getElementById('feedBody');
  const trades = snap.recent_trades || [];
  body.innerHTML = trades.map(t => {
    const isBuy = t.side === 'BUY';
    let rowCls = isBuy ? 'buy' : (t.realized_pnl >= 0 ? 'sell-profit' : 'sell-loss');
    const sideSpan = isBuy
      ? `<span class="side-buy">Master bought</span>`
      : `<span class="side-sell">Master sold</span>`;
    const costLine = isBuy
      ? `<div class="cost">${fmtMoney(t.demo_cost)}</div>`
      : `<div class="cost credit">+${fmtMoney(t.demo_cost)}</div>`;
    const realizedLine = !isBuy ? `<div style="color:${t.realized_pnl>=0?'var(--emerald)':'var(--rose)'}; font-size:11px;">${pnlSign(t.realized_pnl)}${fmtMoney(t.realized_pnl)} realized</div>` : '';
    return `
      <div class="feed-row ${rowCls}">
        <span class="time">${timeAgo(t.timestamp)}</span>
        <div class="desc">
          ${sideSpan} <span class="mkt">${t.market_title}</span> (${t.outcome_label}) — ${fmtShares(t.master_trade_size)} sh @ ${fmtPrice(t.price)}
          <br><span style="color:var(--muted)">copied ${fmtShares(t.demo_copy_size)} sh</span>
          <span class="note-tag ${t.note}">${t.note.replace('_',' ')}</span>
        </div>
        <div class="figures">
          ${costLine}
          ${realizedLine}
        </div>
      </div>`;
  }).join('') || `<div class="event-row">No copy trades yet.</div>`;
}

function renderEvents(snap) {
  const body = document.getElementById('eventsBody');
  const rows = [...snap.events].reverse();
  body.innerHTML = rows.map(e => `
    <div class="event-row ${e.level === 'error' ? 'error' : ''}">
      <span class="t">${timeAgo(e.ts)}</span><span>${e.text}</span>
    </div>
  `).join('') || `<div class="event-row">No events yet.</div>`;
}

function render(snap) {
  document.getElementById('modePill').textContent = snap.mode.includes('DEMO') ? 'DEMO' : snap.mode;
  document.getElementById('walletChip').textContent = shortAddr(snap.master_wallet);
  document.getElementById('ratioText').textContent = `${(snap.config.copy_ratio*100).toFixed(0)}%`;
  renderHero(snap);
  renderStrip(snap);
  renderPositions(snap);
  renderFeed(snap);
  renderEvents(snap);
  document.getElementById('footUptime').textContent = `uptime ${fmtSecs(snap.uptime_seconds)}`;
}

function setConn(state, detail) {
  const el = document.getElementById('connStatus');
  const txt = document.getElementById('connText');
  el.className = 'conn ' + state;
  const labels = { live: 'live', polling: 'live (polling fallback)', down: detail || 'disconnected — retrying' };
  txt.textContent = labels[state] || state;
}

let wsFailCount = 0;
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  console.warn('WebSocket unavailable after several attempts — falling back to REST polling of /api/snapshot.');
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/snapshot');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
      setConn('polling');
    } catch (e) {
      console.error('polling fallback failed:', e);
      setConn('down', 'server unreachable — check it is running');
    }
  }, 3000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function connect() {
  if (location.protocol === 'file:') {
    console.error(
      'This page was opened as a local file (file://). Run `pip install -r requirements.txt` then ' +
      '`uvicorn app.main:app --reload --port 8000` and open http://localhost:8000 instead.'
    );
    setConn('down', 'open via http://localhost, not as a local file — see console');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch (e) {
    console.error('failed to construct WebSocket:', e);
    wsFailCount++;
    if (wsFailCount >= 3) startPolling();
    setTimeout(connect, 2000);
    return;
  }
  ws.onopen = () => { wsFailCount = 0; stopPolling(); setConn('live'); };
  ws.onmessage = (ev) => render(JSON.parse(ev.data));
  ws.onerror = (ev) => console.error('WebSocket error:', ev);
  ws.onclose = (ev) => {
    console.warn(`WebSocket closed (code ${ev.code}${ev.reason ? ', reason: ' + ev.reason : ''}).`);
    wsFailCount++;
    if (wsFailCount >= 3) startPolling();
    setConn('down');
    setTimeout(connect, 2000);
  };
}
connect();
fetch('/api/snapshot').then(r => r.ok && r.json()).then(snap => snap && render(snap)).catch(() => {});
