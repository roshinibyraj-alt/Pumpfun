import asyncio
import logging

import uvicorn

from app import config, server
from app.strategy import Bot

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("main")


async def main():
    bot = Bot()
    server.bot = bot

    config_uv = uvicorn.Config(server.app, host="0.0.0.0", port=config.PORT, log_level="info")
    uv_server = uvicorn.Server(config_uv)

    log.info("Starting bot in PAPER mode with $%.2f virtual capital", config.STARTING_CAPITAL_USD)
    try:
        await asyncio.gather(
            bot.run_forever(),
            uv_server.serve(),
        )
    finally:
        await bot.close()


if __name__ == "__main__":
    asyncio.run(main())
