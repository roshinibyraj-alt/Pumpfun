from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .state import BotState

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

bot_state = BotState()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bot_state.start()
    yield
    await bot_state.stop()


app = FastAPI(title="Pumpfun — CLOB BTC 5m Binary Bot", lifespan=lifespan)


@app.get("/api/state")
async def get_state():
    return bot_state.snapshot()


@app.get("/api/logs")
async def get_logs(
    limit: int = Query(100, ge=1, le=1000),
    event: Optional[str] = None,
    window: Optional[str] = None,
    side: Optional[str] = None,
):
    tracker = bot_state.broker.tracker
    records = tracker.query(limit=limit, event=event, window=window, side=side)
    return {
        "count": len(records),
        "events": records,
        "summary": tracker.summary(),
    }


@app.get("/api/logs/summary")
async def get_log_summary():
    return bot_state.broker.tracker.summary()


@app.get("/")
async def dashboard():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
