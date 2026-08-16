// ============================================================
// polymarket.js — finds the currently-live BTC/ETH 15-min
// up/down market and reads its prices, using Polymarket's
// public, keyless APIs (Gamma for market info, CLOB for prices).
// ============================================================

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

function currentWindowStartUnix(windowMinutes) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = windowMinutes * 60;
  return nowSec - (nowSec % windowSec);
}

async function fetchMarketBySlug(slug) {
  const res = await fetch(`${GAMMA_BASE}/markets?slug=${slug}`);
  if (!res.ok) return null;
  const data = await res.json();
  const market = Array.isArray(data) ? data[0] : data;
  return market || null;
}

// Deterministic slug guess, with a couple of nearby fallbacks in case of
// clock skew or Polymarket rounding windows slightly differently.
async function getCurrentUpDownMarket(asset, windowMinutes) {
  const windowSec = windowMinutes * 60;
  const base = currentWindowStartUnix(windowMinutes);
  const candidates = [base, base - windowSec, base + windowSec];

  for (const ts of candidates) {
    const slug = `${asset}-updown-${windowMinutes}m-${ts}`;
    const market = await fetchMarketBySlug(slug);
    if (market && market.clobTokenIds) {
      return { market, windowStart: ts, windowEnd: ts + windowSec };
    }
  }
  return null;
}

// clobTokenIds usually comes back as a JSON-encoded string array: '["123","456"]'
// Order is not guaranteed, so we always verify against outcomes[] rather
// than assuming — if outcomes is missing, we refuse to guess.
function parseTokens(market) {
  const tokenIds = JSON.parse(market.clobTokenIds);
  if (!market.outcomes) {
    throw new Error('Market has no outcomes field — cannot safely determine Up/Down token order');
  }
  const outcomes = JSON.parse(market.outcomes);
  const upIndex = outcomes.findIndex((o) => /up|yes/i.test(o));
  const downIndex = outcomes.findIndex((o) => /down|no/i.test(o));
  if (upIndex === -1 || downIndex === -1) {
    throw new Error(`Could not identify Up/Down outcomes from: ${market.outcomes}`);
  }
  return {
    upTokenId: tokenIds[upIndex],
    downTokenId: tokenIds[downIndex],
  };
}

// Midpoint price = our best estimate of "what the market currently implies"
// for a token, expressed as a probability between 0 and 1.
async function getMidpoint(tokenId) {
  const res = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`CLOB midpoint fetch failed: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.mid);
}

// Historical midpoint/trade ticks for a token between startTs and
// endTs (epoch seconds). Returns [{ t, p }] sorted by time. Used by
// the learn backtester to replay windows against real prices.
async function getPriceHistory(tokenId, startTs, endTs, fidelity = 1) {
  const url = `${CLOB_BASE}/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CLOB prices-history failed: ${res.status}`);
  const data = await res.json();
  const hist = (data && Array.isArray(data.history)) ? data.history : [];
  return hist
    .filter((h) => h.t != null && h.p != null)
    .map((h) => ({ t: h.t, p: parseFloat(h.p) }))
    .sort((a, b) => a.t - b.t);
}

// Market info by exact slug (used by the learn backtester to resolve
// token ids for historical windows).
async function getMarketBySlug(slug) {
  return fetchMarketBySlug(slug);
}

// Events (including CLOSED ones) by exact slug. /markets?slug only
// returns live markets, so the learn backtester uses this for
// historical windows. Returns the first event, or null.
async function getEventBySlug(slug) {
  const res = await fetch(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

module.exports = { getCurrentUpDownMarket, parseTokens, getMidpoint, getPriceHistory, getMarketBySlug, getEventBySlug };
