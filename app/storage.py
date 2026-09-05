"""
Lightweight SQLite persistence so the bot survives a Railway restart
without losing balance/trade history. Railway's filesystem is ephemeral
on redeploys unless you attach a Volume -- see README for how to mount
one at /data so this file (and your P&L history) actually persists.

Fully multi-instance aware: the 5m and 15m bots are completely
independent (separate bankroll, separate positions, separate everything),
so every function here takes an `instance` label ("5m" / "15m") and
namespaces its data accordingly -- a single shared SQLite file, but never
mixed rows or balances between instances.
"""
import json
import logging
import sqlite3
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
            instance TEXT,
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
    # Light migration: older DBs from before multi-instance support won't
    # have the `instance` column. Ignore the error if it already exists.
    try:
        conn.execute("ALTER TABLE trades ADD COLUMN instance TEXT")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    return conn


def _balance_key(instance: str) -> str:
    return f"balance:{instance}"


def save_balance(instance: str, balance: float):
    conn = _connect()
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (_balance_key(instance), json.dumps(balance)),
    )
    conn.commit()
    conn.close()


def load_balance(instance: str, default: float) -> float:
    conn = _connect()
    row = conn.execute("SELECT value FROM kv WHERE key=?", (_balance_key(instance),)).fetchone()
    conn.close()
    if row:
        try:
            return float(json.loads(row[0]))
        except Exception:
            return default
    return default


def record_trade(instance: str, position):
    """position: engine.Position (already CLOSED_TP or RESOLVED)"""
    conn = _connect()

    def leg_to_dict(lf):
        return {
            "asset": lf.asset, "outcome": lf.outcome, "token_id": lf.token_id,
            "shares": lf.shares, "avg_price": lf.avg_price, "fee": lf.fee,
            "fully_filled": lf.fully_filled,
        }

    raw = {
        "id": position.id,
        "instance": instance,
        "pair_id": position.pair_id,
        "window_start": position.window_start,
        "status": position.status,
        "opened_at": position.opened_at,
        "closed_at": position.closed_at,
        "has_tp": position.has_tp,
        "entry_shares_per_leg": position.entry_shares_per_leg,
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
        (id, instance, pair_id, window_start, status, opened_at, closed_at,
         entry_cost, entry_fees, exit_proceeds, exit_fees,
         resolution_payout, realized_pnl, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            position.id, instance, position.pair_id, position.window_start, position.status,
            position.opened_at, position.closed_at,
            position.entry_cost, position.entry_fees,
            position.exit_proceeds, position.exit_fees,
            position.resolution_payout, position.realized_pnl,
            json.dumps(raw),
        ),
    )
    conn.commit()
    conn.close()


def load_history(instance: str, limit: int = 200):
    conn = _connect()
    rows = conn.execute(
        "SELECT raw_json FROM trades WHERE instance = ? ORDER BY closed_at DESC LIMIT ?",
        (instance, limit),
    ).fetchall()
    conn.close()
    return [json.loads(r[0]) for r in rows]
