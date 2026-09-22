"""Structured bot event logging for Railway and later analysis."""
import json
import logging
import os
import sys
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from . import config
from .models import TradeLogEntry


class LogTracker:
    """Write every bot event to stdout and a rotating JSONL ledger."""

    def __init__(self, path: Optional[str] = None):
        self.path = Path(path or config.LOG_FILE_PATH)
        self.max_bytes = config.LOG_FILE_MAX_BYTES
        self._lock = threading.Lock()
        self.logger = logging.getLogger("pumpfun.bot")
        self._configure_logger()

    def _configure_logger(self):
        self.logger.setLevel(logging.INFO)
        self.logger.propagate = False
        if not self.logger.handlers:
            handler = logging.StreamHandler(sys.stdout)
            handler.setFormatter(
                logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
            )
            self.logger.addHandler(handler)

    def record(self, entry: TradeLogEntry):
        payload = asdict(entry)
        line = json.dumps(payload, separators=(",", ":"), allow_nan=False)
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self._rotate_if_needed(len(line) + 1)
                with self.path.open("a", encoding="utf-8") as output:
                    output.write(line + "\n")
            except OSError:
                self.logger.exception("bot_event_file_write_failed path=%s", self.path)
        self.logger.info("bot_event %s", line)

    def _rotate_if_needed(self, incoming_bytes: int):
        if not self.path.exists() or self.path.stat().st_size + incoming_bytes <= self.max_bytes:
            return
        backup = self.path.with_name(f"{self.path.name}.1")
        try:
            backup.unlink(missing_ok=True)
        except OSError:
            pass
        self.path.replace(backup)

    def _read_records(self):
        records = []
        for path in (self.path.with_name(f"{self.path.name}.1"), self.path):
            if not path.exists():
                continue
            try:
                with path.open("r", encoding="utf-8") as source:
                    for line in source:
                        try:
                            records.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
            except OSError:
                continue
        return records

    def query(
        self,
        limit: int = 100,
        event: Optional[str] = None,
        window: Optional[str] = None,
        side: Optional[str] = None,
    ):
        records = self._read_records()
        filtered = [
            record
            for record in records
            if (event is None or record.get("event") == event)
            and (window is None or record.get("window_slug") == window)
            and (side is None or record.get("side") == side)
        ]
        return list(reversed(filtered[-max(1, min(limit, 1000)) :]))

    def summary(self):
        records = self._read_records()
        event_counts = {}
        realized_pnl = 0.0
        maker_rebates = 0.0
        for record in records:
            name = record.get("event") or "UNKNOWN"
            event_counts[name] = event_counts.get(name, 0) + 1
            realized_pnl += float(record.get("pnl") or 0.0)
            maker_rebates += float(record.get("maker_rebate") or 0.0)
        return {
            "records": len(records),
            "event_counts": event_counts,
            "pnl_logged": round(realized_pnl, 4),
            "maker_rebates_logged": round(maker_rebates, 4),
            "log_file": str(self.path),
        }