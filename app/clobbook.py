"""
Thin wrapper around Polymarket's public (no-auth) CLOB order book endpoint.
We never sign or submit real orders -- this bot only reads book data and
simulates fills against it (see fills.py).
"""
import logging
from dataclasses import dataclass, field
from typing import List, Tuple

import httpx

from . import config

log = logging.getLogger("clobbook")


@dataclass
class OrderBook:
    token_id: str
    bids: List[Tuple[float, float]] = field(default_factory=list)  # (price, size) desc by price
    asks: List[Tuple[float, float]] = field(default_factory=list)  # (price, size) asc by price
    last_trade_price: float = None

    @property
    def best_bid(self):
        return self.bids[0][0] if self.bids else None

    @property
    def best_ask(self):
        return self.asks[0][0] if self.asks else None


class ClobClient:
    def __init__(self):
        self._client = httpx.AsyncClient(base_url=config.CLOB_BASE, timeout=8.0)

    async def close(self):
        await self._client.aclose()

    async def get_book(self, token_id: str) -> OrderBook:
        resp = await self._client.get("/book", params={"token_id": token_id})
        resp.raise_for_status()
        data = resp.json()

        def parse_levels(levels, reverse):
            out = []
            for lvl in levels or []:
                try:
                    out.append((float(lvl["price"]), float(lvl["size"])))
                except (KeyError, TypeError, ValueError):
                    continue
            out.sort(key=lambda x: x[0], reverse=reverse)
            return out

        bids = parse_levels(data.get("bids"), reverse=True)
        asks = parse_levels(data.get("asks"), reverse=False)
        last = data.get("last_trade_price")
        return OrderBook(
            token_id=token_id,
            bids=bids,
            asks=asks,
            last_trade_price=float(last) if last is not None else None,
        )
