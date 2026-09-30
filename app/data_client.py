"""
Thin async client over Polymarket's public, no-auth-required Data API
(https://data-api.polymarket.com) and CLOB price endpoint
(https://clob.polymarket.com). Pure reads — no wallet, no signing, no key.

Field parsing is written defensively (several fallback key names per field)
because the exact v2 response shape for /v2/positions and /v2/trades could
not be verified against a live call from the build sandbox (no network
egress there). If Polymarket's field names differ from what's assumed here,
the engine logs the raw row so it's easy to spot and patch post-deploy —
see README "Known limitations".
"""
from __future__ import annotations
import logging
from typing import Optional, Any
import httpx

from . import config

log = logging.getLogger("data_client")


def _f(d: dict, *keys, default=None):
    """First present, non-None value among several possible field-name spellings."""
    for k in keys:
        if k in d and d[k] is not None:
            try:
                return float(d[k])
            except (TypeError, ValueError):
                return d[k]
    return default


def _s(d: dict, *keys, default=""):
    for k in keys:
        if k in d and d[k] is not None:
            return str(d[k])
    return default


class DataClient:
    def __init__(self):
        self._client = httpx.AsyncClient(timeout=config.HTTP_TIMEOUT)

    async def close(self):
        await self._client.aclose()

    async def _get(self, base: str, path: str, params: dict) -> Optional[Any]:
        try:
            resp = await self._client.get(f"{base}{path}", params=params)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            log.warning("GET %s%s %s failed: %s", base, path, params, e)
            return None

    # ---- trades ---------------------------------------------------------
    async def get_recent_trades(self, wallet: str, limit: int = 50) -> list[dict]:
        """Raw rows from /v2/trades?user=, newest first, normalized."""
        data = await self._get(config.DATA_API, "/v2/trades", {
            "user": wallet, "limit": limit, "taker_only": "true",
        })
        rows = (data or {}).get("data") or []
        out = []
        for row in rows:
            token_id = _s(row, "token_id", "asset_id")
            size = _f(row, "size", default=0.0)
            price = _f(row, "price", default=None)
            ts = _f(row, "timestamp", "block_timestamp", "match_time", default=0.0)
            side = _s(row, "side", default="BUY").upper()
            tx = _s(row, "transaction_hash", "tx_hash")
            if not token_id or price is None or not size:
                continue
            out.append({
                "token_id": token_id,
                "condition_id": _s(row, "condition_id", "conditionId", "market"),
                "market_title": _s(row, "title", "market_title", "question", default="Unknown market"),
                "outcome_label": _s(row, "outcome", "outcome_label", default="?"),
                "slug": _s(row, "slug", "market_slug"),
                "icon": _s(row, "icon", "image", "icon_url"),
                "side": side if side in ("BUY", "SELL") else "BUY",
                "size": size,
                "price": price,
                "timestamp": ts,
                "transaction_hash": tx,
                "key": f"{tx}:{token_id}:{side}:{size}:{price}:{ts}",
            })
        return out

    # ---- profile stats (best-effort, purely cosmetic) --------------------
    async def get_user_stats(self, wallet: str) -> Optional[dict]:
        data = await self._get(config.DATA_API, "/v2/user-stats", {"user": wallet})
        row = (data or {}).get("data")
        if not row:
            return None
        return {
            "trades": row.get("trades"),
            "biggest_win": row.get("biggest_win"),
            "join_date": row.get("join_date"),
            "all_time_pnl": (row.get("all_time_pnl") or {}).get("p") if isinstance(row.get("all_time_pnl"), dict) else None,
        }

    async def get_portfolio_value(self, wallet: str) -> Optional[float]:
        data = await self._get(config.DATA_API, "/v2/value", {"user": wallet})
        row = (data or {}).get("data")
        if not row:
            return None
        return _f(row, "value", default=None)

    # ---- CLOB price (mark-to-market for our copied holdings) -------------
    async def get_price(self, token_id: str, side: str = "sell") -> Optional[float]:
        try:
            resp = await self._client.get(
                f"{config.CLOB_API}/price",
                params={"token_id": token_id, "side": side},
                timeout=config.HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            price = data.get("price")
            return float(price) if price is not None else None
        except Exception as e:
            log.debug("price fetch failed for token %s: %s", token_id, e)
            return None
