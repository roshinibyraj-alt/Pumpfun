"""
Lightweight SQLite persistence so the bot survives a Railway restart
without losing balances/skip-state/history. Attach a Railway Volume at
/data for this to actually persist across redeploys.
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
    conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY,
            engine_label TEXT,
            window_start INTEGER,
            outcome TEXT,
            status TEXT,
            is_shadow INTEGER,
            opened_at REAL,
            closed_at REAL,
            entry_price REAL,
            shares REAL,
            entry_cost REAL,
            entry_fee REAL,
            exit_price REAL,
            exit_proceeds REAL,
            raw_pnl REAL,
            won INTEGER,
            raw_json TEXT
        )
        """
    )
    conn.commit()
    return conn


def save_engine_state(engine_label: str, balance: float, skip_counter: int):
    conn = _connect()
    key = f"engine_state:{engine_label}"
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps({"balance": balance, "skip_counter": skip_counter})),
    )
    conn.commit()
    conn.close()


def load_engine_state(engine_label: str, default_balance: float) -> dict:
    conn = _connect()
    row = conn.execute(
        "SELECT value FROM kv WHERE key=?", (f"engine_state:{engine_label}",)
    ).fetchone()
    conn.close()
    if row:
        try:
            saved = json.loads(row[0])
            return {
                "balance": float(saved.get("balance", default_balance)),
                "skip_counter": int(saved.get("skip_counter", 0)),
            }
        except Exception:
            pass
    return {"balance": default_balance, "skip_counter": 0}


def record_position(pos):
    conn = _connect()
    raw = {
        "id": pos.id, "engine_label": pos.engine_label, "window_start": pos.window_start,
        "outcome": pos.outcome, "status": pos.status, "is_shadow": pos.is_shadow,
        "opened_at": pos.opened_at, "closed_at": pos.closed_at,
        "entry_price": pos.entry_price, "shares": pos.shares,
        "entry_cost": pos.entry_cost, "entry_fee": pos.entry_fee,
        "exit_price": pos.exit_price, "exit_proceeds": pos.exit_proceeds, "exit_fee": pos.exit_fee,
        "raw_pnl": pos.raw_pnl, "resolution_won": pos.resolution_won, "won": pos.won,
    }
    conn.execute(
        """
        INSERT OR REPLACE INTO positions
        (id, engine_label, window_start, outcome, status, is_shadow, opened_at, closed_at,
         entry_price, shares, entry_cost, entry_fee, exit_price, exit_proceeds, raw_pnl, won, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            pos.id, pos.engine_label, pos.window_start, pos.outcome, pos.status, int(pos.is_shadow),
            pos.opened_at, pos.closed_at, pos.entry_price, pos.shares, pos.entry_cost, pos.entry_fee,
            pos.exit_price, pos.exit_proceeds, pos.raw_pnl,
            int(bool(pos.won)) if pos.won is not None else None, json.dumps(raw),
        ),
    )
    conn.commit()
    conn.close()
