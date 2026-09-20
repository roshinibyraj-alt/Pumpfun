"""Orchestration with a fake Binance + fake Polymarket: candle fetch/retry, window rolling, late join, the full path."""
import os, sys, asyncio, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from app import config, state as S
from app.binance import MinuteCandle
from app.models import WindowMarket

T0 = 1_800_000_000
clock = {"now": float(T0 + 100)}
class FakeTime:
    @staticmethod
    def time(): return clock["now"]
S.time = FakeTime

books = {"u": {"bid": 0.44, "ask": 0.46, "asks": [(0.46, 1000)], "bids": [(0.44, 1000)]},
         "d": {"bid": 0.52, "ask": 0.54, "asks": [(0.54, 1000)], "bids": [(0.52, 1000)]}}
class FakeClient:
    async def get_active_window(self, now):
        o = int(now // 300) * 300
        return WindowMarket(f"btc-updown-5m-{o}", "c", "u", "d", float(o), float(o + 300)), None
    async def get_book_full(self, token):
        b = books[token]
        return {"best_bid": b["bid"], "best_ask": b["ask"], "bids": b["bids"], "asks": b["asks"]}
    async def close(self): pass

fetch_log = []
avail = {"minutes": 5}          # how many of the previous window's minute candles Binance has "closed"
prev_closes = {"c": [100.0, 99.0, 99.8, 100.2, 100.5]}
async def fake_fetch(client, open_ts):
    fetch_log.append(open_ts)
    return [MinuteCandle(open_time=open_ts + 60 * i, close=prev_closes["c"][i], close_time=open_ts + 60 * i + 59.999)
            for i in range(avail["minutes"])]
S.fetch_window_minutes = fake_fetch

async def run_to(bs, t_end, step=1.0):
    while clock["now"] < t_end:
        clock["now"] += step
        await bs._tick()

async def main():
    bs = S.BotState(); bs.client = FakeClient()
    # start 100s into a window -> late join, no trade in it
    await bs._tick()
    assert bs.engine.s.signal_status == "late_join" and bs.engine.s.position is None
    print("1 ok: joined mid-window -> skipped")

    # roll into the next window; only 4 of 5 minute candles closed at first -> waits (no entry), then trades
    avail["minutes"] = 4
    await run_to(bs, T0 + 300)
    assert bs.engine.s.signal_status == "pending" and "4/5" in (bs.signal_error or "")
    assert fetch_log and all(o == T0 for o in fetch_log), fetch_log        # reads the PREVIOUS window's minutes
    avail["minutes"] = 5
    e = bs.engine
    await run_to(bs, T0 + 300 + 1)
    assert e.s.signal_status == "armed" and e.s.position is None and e.snapshot()["status"] == "entry_pending"
    print("2 ok: waited for the 5th minute, UP signal armed at +1s, nothing bought yet")

    # +2s after the window opens -> taker buy 300sh on UP at the ask (0.46), no limit order anywhere
    await run_to(bs, T0 + 300 + 2)
    assert e.s.position and e.s.position.side.value == "UP" and e.s.position.shares == 300
    assert abs(e.s.position.entry_price - 0.46) < 1e-9 and "LIMIT_PLACED" not in [x.event for x in bs.broker.log]
    print("3 ok: +2s -> taker 300sh UP @", round(e.s.position.entry_price, 4))

    # next window: pattern absent -> no trade; position from previous window was force-closed at the roll
    prev_closes["c"] = [100.0, 100.0, 100.0, 100.0, 100.0]
    await run_to(bs, T0 + 600 + 5)
    assert e.total_forced_closes + e.total_tp_fills == 1 and e.s.signal_status == "no_pattern" and e.s.position is None
    assert e.history[0]["entry"] == "taker"
    print("4 ok: window rolled -> old position closed, flat candles -> no trade")

    # candles never arrive -> gives up after SIGNAL_MAX_WAIT_SECONDS
    avail["minutes"] = 0
    await run_to(bs, T0 + 900 + int(config.SIGNAL_MAX_WAIT_SECONDS) + 3)
    assert e.s.signal_status == "no_data" and e.total_no_data == 1
    print("5 ok: candles never arrive -> window skipped after", int(config.SIGNAL_MAX_WAIT_SECONDS), "s")

    # DOWN pattern in the following window -> at +2s buys DOWN at ITS ask (0.54), whatever the price
    avail["minutes"] = 5; prev_closes["c"] = [100.0, 101.0, 100.2, 99.8, 99.5]
    books["d"].update(ask=0.93, asks=[(0.93, 1000)])
    await run_to(bs, T0 + 1200 + 1)
    assert e.s.signal_status == "armed" and e.s.position is None
    await run_to(bs, T0 + 1200 + 3)
    assert e.s.position and e.s.position.side.value == "DOWN" and e.s.position.shares == 300
    assert abs(e.s.position.entry_price - 0.93) < 1e-9
    print("6 ok: DOWN pattern -> buys DOWN at +2s even at a 0.93 ask")
    snap = bs.snapshot(); json.dumps(snap)
    assert snap["engine"]["history"] and snap["signal_error"] is None
    print("7 ok: dashboard snapshot serialises; history rows:", len(snap["engine"]["history"]))

    # ---- live min1-min5 BTC prices of the CURRENT window (dashboard strip) ----------------------
    win = bs.current_window; live_calls = []
    def candles_now(n):
        return [MinuteCandle(open_time=win.open_ts + 60 * i, open=100.0 + i, close=100.5 + i,
                             close_time=win.open_ts + 60 * i + 59.999) for i in range(n)]
    async def fake_live(client, open_ts):
        live_calls.append(open_ts); return candles_now(3)
    S.fetch_window_minutes = fake_live
    now = win.open_ts + 130                                # 130s in: min1, min2 closed; min3 still forming
    clock["now"] = now
    await bs._refresh_live_minutes(now)
    assert live_calls == [win.open_ts]                      # asks for the CURRENT window, not the previous one
    m = bs.snapshot()["btc_minutes"]; json.dumps(m)
    assert [x["state"] for x in m["minutes"]] == ["closed", "closed", "live", "pending", "pending"], m
    assert m["open_price"] == 100.0 and m["minutes"][0]["price"] == 100.5 and m["minutes"][0]["change"] == 0.5
    assert m["minutes"][1]["change"] == 1.0 and m["minutes"][3]["price"] is None and m["updated_ts"] == now
    print("8 ok: live strip -> closed, closed, live, pending, pending (current window's candles)")

    # after the roll the strip resets: old window's prices are never shown against the new window
    clock["now"] = win.open_ts + 300 + 1
    await bs._tick()
    m = bs.snapshot()["btc_minutes"]
    assert bs.current_window.slug != win.slug and all(x["state"] == "pending" and x["price"] is None for x in m["minutes"])
    # a Binance failure keeps trading untouched and surfaces the error
    async def boom(client, open_ts): raise RuntimeError("binance down")
    S.fetch_window_minutes = boom
    await bs._refresh_live_minutes(clock["now"])
    assert "binance down" in bs.snapshot()["btc_minutes"]["error"]
    print("9 ok: strip resets on the new window; a Binance error is shown, nothing else affected")
asyncio.run(main())
print("STATE TESTS PASSED")
