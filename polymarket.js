// ============================================================
// polymarket.js — finds the currently-live BTC/ETH 15-min
// up/down market and reads its prices, using Polymarket's
// public, keyless APIs (Gamma for market info, CLOB for prices).
//
// NOTE: Polymarket's API has moved around before. If market
// discovery starts failing, check the logs — the fallback
// search (below) usually recovers it even if the slug format
// changes slightly.
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
// Order is typically [UP/YES token, DOWN/NO token] but we double check via outcomes[].
function parseTokens(market) {
  const tokenIds = JSON.parse(market.clobTokenIds);
  const outcomes = JSON.parse(market.outcomes || '["Up","Down"]');
  const upIndex = outcomes.findIndex((o) => /up|yes/i.test(o));
  const downIndex = upIndex === 0 ? 1 : 0;
  return {
    upTokenId: tokenIds[upIndex >= 0 ? upIndex : 0],
    downTokenId: tokenIds[downIndex >= 0 ? downIndex : 1],
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

module.exports = { getCurrentUpDownMarket, parseTokens, getMidpoint };
