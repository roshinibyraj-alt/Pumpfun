'use strict';

const CLOB_HOST = 'https://clob.polymarket.com';

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function bestFromBook(book) {
  const bids = (book && book.bids || []).map((x) => numberOrNull(x.price)).filter((x) => x != null);
  const asks = (book && book.asks || []).map((x) => numberOrNull(x.price)).filter((x) => x != null);
  return {
    bid: bids.length ? Math.max(...bids) : null,
    ask: asks.length ? Math.min(...asks) : null,
  };
}

function startMarketFeed(assetIds, onQuote, onError = () => {}) {
  const ids = [...new Set((assetIds || []).map(String).filter(Boolean))];
  let stopped = false;
  let timer = null;
  let failures = 0;

  async function poll() {
    if (stopped) return;
    const startedAt = Date.now();
    try {
      const books = await Promise.all(ids.map(async (assetId) => {
        const response = await fetch(CLOB_HOST + '/book?token_id=' + encodeURIComponent(assetId), {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('CLOB order book returned HTTP ' + response.status);
        return { assetId, book: await response.json() };
      }));
      failures = 0;
      for (const { assetId, book } of books) {
        onQuote(assetId, bestFromBook(book));
      }
    } catch (error) {
      failures += 1;
      try { onError(error instanceof Error ? error : new Error(String(error))); } catch (_) {}
    }
    if (stopped) return;
    const interval = failures ? Math.min(500 * (2 ** Math.min(failures, 4)), 8000) : 500;
    timer = setTimeout(() => { void poll(); }, Math.max(0, interval - (Date.now() - startedAt)));
  }

  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

module.exports = startMarketFeed;