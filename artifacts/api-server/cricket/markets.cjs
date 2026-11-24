'use strict';
const { parseMarketUrl } = require('./engine.cjs');
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Polymarket returned HTTP ${response.status}. Please retry.`);
  return response.json();
}
const array = x => Array.isArray(x) ? x : JSON.parse(x || '[]');
function cryptoWindowFromSlug(slug) {
  const match = /^([a-z0-9]+)-updown-5m-(\d{10})$/.exec(slug || '');
  if (!match) return null;
  const startTimestamp = Number(match[2]);
  if (!Number.isSafeInteger(startTimestamp) || startTimestamp % 300 !== 0) return null;
  return { symbol: match[1].toUpperCase(), startTimestamp, intervalSeconds: 300 };
}
function nextCryptoWindowSlug(match, now = Date.now()) {
  const window = match?.cryptoWindow;
  if (!window || !Number.isSafeInteger(window.startTimestamp) || window.intervalSeconds !== 300) return null;
  if (now < (window.startTimestamp + window.intervalSeconds) * 1000) return null;
  const currentBoundary = Math.floor(now / (window.intervalSeconds * 1000)) * window.intervalSeconds;
  const nextStart = Math.max(window.startTimestamp + window.intervalSeconds, currentBoundary);
  return `${window.symbol.toLowerCase()}-updown-5m-${nextStart}`;
}
function metadata(raw) {
  const schedule = raw.feeSchedule || raw.fee_schedule;
  const disabled = raw.feesEnabled === false;
  const rate = disabled ? 0 : Number(schedule?.rate);
  const exponent = disabled ? 1 : Number(schedule?.exponent);
  return {
    closed: !!raw.closed, acceptingOrders: raw.acceptingOrders === true,
    secondsDelay: raw.secondsDelay === null || raw.secondsDelay === undefined ? null : Number(raw.secondsDelay),
    feeRate: Number.isFinite(rate) && rate >= 0 ? rate : 0,
    feeExponent: Number.isFinite(exponent) && exponent > 0 ? exponent : 1,
    feeKnown: disabled || (Number.isFinite(rate) && rate >= 0 && Number.isFinite(exponent) && exponent > 0),
    minOrderSize: Number(raw.orderMinSize) > 0 ? Number(raw.orderMinSize) : 5,
    tickSize: Number(raw.orderPriceMinTickSize) > 0 ? Number(raw.orderPriceMinTickSize) : 0.01,
    resolutionStatus: raw.umaResolutionStatus || null,
  };
}
async function loadMatch(url) {
  const slug = parseMarketUrl(url);
  const cryptoWindow = cryptoWindowFromSlug(slug);
  let events = await json(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
  if (!events.length) {
    const markets = await json(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
    const eventSlug = markets[0]?.events?.[0]?.slug;
    if (!eventSlug) throw new Error('No matching event found. Paste a Polymarket cricket event or crypto 5-minute Up/Down URL.');
    events = await json(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`);
  }
  const event = events[0];
  if (!event) throw new Error('Market not found.');
  const tags = (event.tags || []).map(x => `${x.slug} ${x.label}`).join(' ');
  const isCricket = /cricket|crint|cric/i.test(`${event.sport || ''} ${event.seriesSlug || ''} ${tags}`);
  if (!isCricket && !cryptoWindow) throw new Error('Paste a cricket event or a crypto five-minute Up/Down market URL.');
  const markets = [];
  for (const raw of event.markets || []) {
    if (!raw.enableOrderBook) continue;
    const ids = array(raw.clobTokenIds), names = array(raw.outcomes);
    if (ids.length < 2 || ids.length !== names.length) continue;
    if (cryptoWindow && !(names.length === 2 && names.some(x => /^up$/i.test(x)) && names.some(x => /^down$/i.test(x))))
      throw new Error('That five-minute crypto event does not contain the expected Up and Down outcomes.');
    // This service uses the CTF CLOB feed. Never misroute V2 position IDs as token IDs.
    if (raw.version && !['v1', 'ctf'].includes(raw.version)) throw new Error('This match uses an unsupported exchange version.');
    markets.push({ id: String(raw.id), conditionId: raw.conditionId, slug: raw.slug, question: raw.question,
      ...metadata(raw), outcomes: ids.map((id, i) => ({ id: String(id), name: names[i],
        shares: 0, costBasis: 0, liquidationValue: 0 })) });
  }
  if (!markets.length) throw new Error('This event has no supported outcome order books.');
  if (markets.length > 40) throw new Error('This event has too many submarkets to load safely.');
  return { id: String(event.id), kind: cryptoWindow ? 'crypto' : 'cricket',
    ...(cryptoWindow ? { cryptoWindow } : {}), slug: event.slug, title: event.title,
    url: `https://polymarket.com/event/${event.slug}`, closed: !!event.closed, markets };
}
module.exports = { json, array, metadata, cryptoWindowFromSlug, nextCryptoWindowSlug, loadMatch };
