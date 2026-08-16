// ============================================================
// predict-15m.js — 15m window UP/DOWN prediction model.
//
//   node predict-15m.js
//
// Predicts the CURRENTLY OPEN 15m window (the "next" window
// relative to the last closed one) using only information
// available at window open: the last 8 windows' winners, streaks,
// momentum, volatility, dip depth, early momentum, and time of
// day. Logistic regression weights were fit on 14 days of real
// Polymarket history (1,344 windows), walk-forward validated.
//
//   HONEST EXPECTATION: at window open the market is roughly a
//   coin flip. Walk-forward accuracy on all windows was ~50%;
//   only high-confidence predictions (|P-0.5| >= 0.10) showed a
//   weak edge (~55%). Treat any prediction as a soft signal, not
//   a certainty — never size bets on this alone.
// ============================================================

const polymarket = require('./polymarket');

// ---- model (fit on 14d / 1,344 windows, tau=0) ----
const MODEL = {
  names: ['sin_hour','cos_hour','w1','w2','w3','w4','streak','mom4','mom8','prev_final_up','prev_range','prev_dip_depth','prev_early_mom'],
  w: [-0.062992, 0.001806, 0.342844, -0.093747, -0.027458, 0.029951, -0.10978, 0.131582, -0.097832, -0.350048, -0.010093, 0.001455, -0.09729],
  b: 0.00329,
  mu: [-0.000105, 0.003205, 0.5, 0.500804, 0.500804, 0.500804, 0.001447, 0.500603, 0.500402, 0.498452, 0.57942, 0.957873, 0.098694],
  sd: [0.708228, 0.705976, 0.5, 0.499999, 0.499999, 0.499999, 0.45544, 0.239006, 0.168556, 0.45927, 0.1331, 0.085298, 0.184236],
};

const WINDOW_SEC = 15 * 60;

function priceAt(ticks, t) {
  let last = null;
  for (const [dt, p] of ticks) {
    if (dt <= t) last = p; else break;
  }
  return last != null ? last : (ticks.length ? ticks[0][1] : null);
}
function minP(ticks) { return ticks.length ? Math.min(...ticks.map((x) => x[1])) : null; }
function maxP(ticks) { return ticks.length ? Math.max(...ticks.map((x) => x[1])) : null; }

function features(windows) {
  const cur = windows[windows.length - 1];
  const hour = (cur.ws % 86400) / 3600;
  const f = [Math.sin(2 * Math.PI * hour / 24), Math.cos(2 * Math.PI * hour / 24)];
  const win = (i) => windows[i].winner === 'UP' ? 1 : 0;
  for (let k = 1; k <= 4; k++) f.push(win(windows.length - 1 - k));
  const lastW = windows[windows.length - 2].winner;
  let streak = 0;
  for (let j = windows.length - 2; j >= 0 && windows[j].winner === lastW; j--) streak++;
  f.push((lastW === 'UP' ? streak : -streak) / 5);
  f.push([1, 2, 3, 4].reduce((a, k) => a + win(windows.length - 1 - k), 0) / 4);
  f.push([1, 2, 3, 4, 5, 6, 7, 8].reduce((a, k) => a + win(windows.length - 1 - k), 0) / 8);
  const pw = windows[windows.length - 2];
  f.push(priceAt(pw.up, WINDOW_SEC));
  f.push(maxP(pw.up) - minP(pw.up));
  const loserTicks = pw.winner === 'UP' ? pw.down : pw.up;
  f.push(1 - minP(loserTicks));
  const winTicks = pw.winner === 'UP' ? pw.up : pw.down;
  f.push(priceAt(winTicks, 300) - priceAt(winTicks, 0));
  return f;
}

function predict(f) {
  let z = MODEL.b;
  for (let i = 0; i < f.length; i++) {
    z += MODEL.w[i] * ((f[i] - MODEL.mu[i]) / MODEL.sd[i]);
  }
  return 1 / (1 + Math.exp(-z));
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const boundary = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;

  // fetch last 9 windows: 8 closed (for features) + the current one
  const windows = [];
  for (let k = 9; k >= 1; k--) {
    const ts = boundary - k * WINDOW_SEC;
    const event = await polymarket.getEventBySlug(`btc-updown-15m-${ts}`);
    if (!event) { console.error(`no event for window ${ts}`); continue; }
    const mk = (event.markets || [])[0];
    const tokens = polymarket.parseTokens(mk);
    let winner = null;
    try {
      const outs = JSON.parse(mk.outcomes || '[]');
      const prices = JSON.parse(mk.outcomePrices || '[]');
      const upIdx = outs.findIndex((o) => /up|yes/i.test(o));
      if (prices.length === 2 && upIdx >= 0) winner = parseFloat(prices[upIdx]) > 0.5 ? 'UP' : 'DOWN';
    } catch (_) {}
    const [upT, downT] = await Promise.all([
      polymarket.getPriceHistory(tokens.upTokenId, ts, ts + WINDOW_SEC, 1),
      polymarket.getPriceHistory(tokens.downTokenId, ts, ts + WINDOW_SEC, 1),
    ]);
    windows.push({ ws: ts, winner, up: upT.map((x) => [x.t - ts, x.p]), down: downT.map((x) => [x.t - ts, x.p]) });
  }

  if (windows.length < 9) { console.error('not enough history fetched'); process.exit(1); }
  const cur = windows[windows.length - 1];
  if (windows.slice(0, 8).some((w) => !w.winner)) { console.error('missing resolved winner in history — try again later'); process.exit(1); }

  const f = features(windows);
  const p = predict(f);
  const side = p >= 0.5 ? 'UP' : 'DOWN';
  const conf = Math.abs(p - 0.5);
  const start = new Date(cur.ws * 1000).toISOString();
  const history = windows.slice(0, 8).map((w) => w.winner[0]).join('');
  console.log(`Window start (UTC): ${start}  (${cur.ws})`);
  console.log(`Last 8 winners:     ${history.split('').join('-')}`);
  console.log(`P(UP) = ${(p * 100).toFixed(1)}%  ->  PREDICT ${side}  (confidence ${(conf * 100).toFixed(1)}%)`);
  if (conf < 0.10) console.log('Note: low confidence — historical accuracy ~50% here, treat as a coin flip.');
  else console.log('Note: high confidence bucket historically ~55% accurate (weak edge).');
}

main().catch((e) => { console.error('predict failed:', e.message); process.exit(1); });
