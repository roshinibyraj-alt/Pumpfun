"""
Lightweight SQLite persistence so the bot survives a Railway restart
without losing balance/trade history. Railway's filesystem is ephemeral
on redeploys unless you attach a Volume -- see README for how to mount
one at /data so this file (and your P&L history) actually persists.
"""
import json
import logging
import sqlite3
import time
from dataclasses import asdict
from pathlib import Path

from . import config

log = logging.getLogger("storage")


def _connect():
    Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY,
            pair_id TEXT,
            window_start INTEGER,
            status TEXT,
            opened_at REAL,
            closed_at REAL,
            entry_cost REAL,
            entry_fees REAL,
            exit_proceeds REAL,
            exit_fees REAL,
            resolution_payout REAL,
            realized_pnl REAL,
            raw_json TEXT
        )
        """
    )
    conn.commit()
    return conn


def save_balance(balance: float):
    conn = _connect()
    conn.execute(
        "INSERT INTO kv(key, value) VALUES('balance', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (json.dumps(balance),),
    )
    conn.commit()
    conn.close()


def load_balance(default: float) -> float:
    conn = _connect()
    row = conn.execute("SELECT value FROM kv WHERE key='balance'").fetchone()
    conn.close()
    if row:
        try:
            return float(json.loads(row[0]))
        except Exception:
            return default
    return default


def record_trade(position):
    """position: engine.Position (already RESOLVED)"""
    conn = _connect()

    def leg_to_dict(lf):
        return {
            "asset": lf.asset, "outcome": lf.outcome, "token_id": lf.token_id,
            "shares": lf.shares, "avg_price": lf.avg_price, "fee": lf.fee,
            "fully_filled": lf.fully_filled,
        }

    raw = {
        "id": position.id,
        "pair_id": position.pair_id,
        "window_start": position.window_start,
        "status": position.status,
        "opened_at": position.opened_at,
        "closed_at": position.closed_at,
        "entry_legs": {k: leg_to_dict(v) for k, v in position.entry_legs.items()},
        "entry_cost": position.entry_cost,
        "entry_fees": position.entry_fees,
        "exit_legs": {k: leg_to_dict(v) for k, v in (position.exit_legs or {}).items()} or None,
        "exit_proceeds": position.exit_proceeds,
        "exit_fees": position.exit_fees,
        "resolution_payout": position.resolution_payout,
        "resolution_detail": position.resolution_detail,
        "realized_pnl": position.realized_pnl,
        "post_fill_check": position.post_fill_check,
    }
    conn.execute(
        """
        INSERT OR REPLACE INTO trades
        (id, pair_id, window_start, status, opened_at, closed_at,
         entry_cost, entry_fees, exit_proceeds, exit_fees,
         resolution_payout, realized_pnl, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            position.id, position.pair_id, position.window_start, position.status,
            position.opened_at, position.closed_at,
            position.entry_cost, position.entry_fees,
            position.exit_proceeds, position.exit_fees,
            position.resolution_payout, position.realized_pnl,
            json.dumps(raw),
        ),
    )
    conn.commit()
    conn.close()


def load_history(limit: int = 200):
    conn = _connect()
    rows = conn.execute(
        "SELECT raw_json FROM trades ORDER BY closed_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [json.loads(r[0]) for r in rows]
