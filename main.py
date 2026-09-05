import asyncio
import logging
import sys

import uvicorn

from app import config, server
from app.strategy import Bot

# ---- Colored, timestamped, per-instance logging ----------------------------
# Every log line already has a timestamp (asctime) and the emitting
# logger's name, which includes the instance label (e.g. "strategy.5m",
# "engine.15m", "gamma.5m"). On top of that, lines from the 5m instance
# and the 15m instance are colored differently (ANSI escape codes) so
# they're visually distinguishable in any terminal/log viewer that
# renders ANSI color (most do, including `railway logs` and local
# terminals). If a viewer doesn't render ANSI, the codes are just a few
# extra invisible-ish characters -- the logger name still disambiguates
# the instance either way.
_INSTANCE_COLORS = {inst.label: inst.color for inst in config.INSTANCES}
_ANSI = {
    "cyan": "\033[96m",
    "magenta": "\033[95m",
    "green": "\033[92m",
    "yellow": "\033[93m",
    "blue": "\033[94m",
    "red": "\033[91m",
}
_RESET = "\033[0m"


class ColorFormatter(logging.Formatter):
    def format(self, record):
        base = super().format(record)
        # logger names look like "strategy.5m", "engine.15m", "gamma.5m" --
        # the last dotted segment is the instance label, if any.
        tag = record.name.rsplit(".", 1)[-1]
        color_name = _INSTANCE_COLORS.get(tag)
        color = _ANSI.get(color_name) if color_name else None
        return f"{color}{base}{_RESET}" if color else base


def _setup_logging():
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(ColorFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]


_setup_logging()
log = logging.getLogger("main")


def _make_bot(inst: "config.WindowInstanceConfig") -> Bot:
    bot_log = logging.getLogger(f"strategy.{inst.label}")
    return Bot(
        label=inst.label,
        window_seconds=inst.window_seconds,
        slug_label=inst.slug_label,
        starting_capital=inst.starting_capital,
        log=bot_log,
    )


async def main():
    bots = [_make_bot(inst) for inst in config.INSTANCES]
    server.bots = {b.label: b for b in bots}

    config_uv = uvicorn.Config(server.app, host="0.0.0.0", port=config.PORT, log_level="info")
    uv_server = uvicorn.Server(config_uv)

    for inst, bot in zip(config.INSTANCES, bots):
        log.info(
            "Starting %s instance in PAPER mode with $%.2f virtual capital (window=%ds, slug='%s')",
            inst.label, inst.starting_capital, inst.window_seconds, inst.slug_label,
        )

    try:
        await asyncio.gather(
            *[bot.run_forever() for bot in bots],
            uv_server.serve(),
        )
    finally:
        await asyncio.gather(*[bot.close() for bot in bots])


if __name__ == "__main__":
    asyncio.run(main())
