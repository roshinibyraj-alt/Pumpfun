import asyncio
import logging
import re

import uvicorn

from app import config, server
from app.strategy import NineEngineBot

_ANSI = {
    "cyan": "\033[96m", "magenta": "\033[95m", "green": "\033[92m",
    "yellow": "\033[93m", "blue": "\033[94m", "red": "\033[91m",
    "bright_magenta": "\033[35m", "bright_cyan": "\033[36m", "white": "\033[97m",
    "reset": "\033[0m",
}
_ENGINE_COLOR_BY_LABEL = {e.label: e.color for e in config.ENGINES}
_LABEL_RE = re.compile(r"\[(E\d)\]")


class ColorFormatter(logging.Formatter):
    def format(self, record):
        base = super().format(record)
        msg = record.getMessage()
        m = _LABEL_RE.search(msg)
        if m:
            color = _ENGINE_COLOR_BY_LABEL.get(m.group(1))
            if color:
                return f"{_ANSI.get(color, '')}{base}{_ANSI['reset']}"
        return base


def setup_logging():
    handler = logging.StreamHandler()
    handler.setFormatter(ColorFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]


log = logging.getLogger("main")


async def main():
    setup_logging()
    bot = NineEngineBot()
    server.bot = bot

    config_uv = uvicorn.Config(server.app, host="0.0.0.0", port=config.PORT, log_level="info")
    uv_server = uvicorn.Server(config_uv)

    log.info("Starting 9-engine bot in PAPER mode: $%.0f/engine x 9 = $%.0f total, %.0f shares/trade",
              config.STARTING_CAPITAL_PER_ENGINE, config.STARTING_CAPITAL_PER_ENGINE * len(config.ENGINES),
              config.SHARES_PER_TRADE)
    try:
        await asyncio.gather(
            bot.run_forever(),
            uv_server.serve(),
        )
    finally:
        await bot.close()


if __name__ == "__main__":
    asyncio.run(main())
