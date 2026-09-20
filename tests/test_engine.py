import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stubs
from app import config
from app.engine import Engine
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker
from app.strategy import evaluate

T = 1_800_000_000
UP_CLOSES = [100.0, 99.0, 99.8, 100.2, 100.5]
DOWN_CLOSES = [100.0, 101.0, 100.2, 99.8, 99.5]
FLAT_CLOSES = [100.0, 100.0, 100.0, 100.0, 100.0]

def mk(closes=UP_CLOSES, late=False, signal=True):
    e = Engine(PaperBroker())
    w = WindowMarket("w", None, "u", "d", float(T), float(T + 300))
    e.reset_for_window(w, late_join=late)
    if signal and not late:
        e.set_signal(evaluate(closes), now=float(T))
    return e

def tick(e, ts, ua, da, ul=None, dl=None, ub=0.30, db=0.30):
    e.on_tick(ub, ua, db, da, 300, now=ts, up_bid_levels=[(ub, 1000)], down_bid_levels=[(db, 1000)],
              up_ask_levels=ul, down_ask_levels=dl)

def ev(e): return [x.event for x in e.broker.log]

# ---- 0. the old order logic is really gone
assert not hasattr(Engine, "_check_fill") and not hasattr(Engine, "_check_taker")
for name in ("LIMIT_PRICE", "LIMIT_SHARES", "LIMIT_TIMEOUT_SECONDS", "TAKER_MAX_PRICE"):
    assert not hasattr(config, name), name
assert config.ENTRY_DELAY_SECONDS == 2 and config.TAKER_SHARES == 300 and config.TP_PRICE == 0.99
print("0 ok: no limit order / timeout / price-cap logic left")

# ---- 1. UP signal arms the entry, nothing is bought before +2s; at +2s: 300sh taker buy on UP
e = mk(UP_CLOSES); bal0 = e.capital.balance
assert e.s.signal_status == "armed" and e.s.position is None and e.snapshot()["status"] == "entry_pending"
assert "LIMIT_PLACED" not in ev(e)
snap = e.snapshot(); assert snap["entry"]["side"] == "UP" and snap["entry"]["shares"] == 300
tick(e, T + 0.5, 0.45, 0.55); tick(e, T + 1.9, 0.45, 0.55); assert e.s.position is None and e.capital.balance == bal0
lv = [(0.45, 100), (0.48, 400)]
tick(e, T + 2.0, 0.45, 0.55, ul=lv)
p = e.s.position
vwap = (100 * 0.45 + 200 * 0.48) / 300
assert p and p.side == Side.UP and p.shares == 300 and abs(p.entry_price - vwap) < 1e-9
fee = e.broker.taker_fee_amount(300, vwap)
assert abs(p.cost - (300 * vwap + fee)) < 1e-9 and abs(bal0 - e.capital.balance - p.cost) < 1e-9
assert e.total_taker_entries == 1 and e.snapshot()["status"] == "open" and e.snapshot()["entry"] is None
print(f"1 ok: nothing before +2s; at +2s taker 300sh @ {vwap:.4f} (depth-walked), fee ${fee:.3f} in cost")

# ---- 2. regardless of price: a 0.97 ask and a 0.03 ask both get bought
for ask in (0.97, 0.03):
    e = mk(UP_CLOSES); tick(e, T + 2, ask, 1 - ask, ul=[(ask, 1000)])
    assert e.s.position and e.s.position.shares == 300 and abs(e.s.position.entry_price - ask) < 1e-9
print("2 ok: buys at any price (0.97 and 0.03)")

# ---- 3. DOWN signal is the exact mirror: buys DOWN, UP's price is irrelevant
e = mk(DOWN_CLOSES)
tick(e, T + 2, 0.30, 0.66, dl=[(0.66, 1000)])
assert e.s.position and e.s.position.side == Side.DOWN and abs(e.s.position.entry_price - 0.66) < 1e-9
print("3 ok: DOWN signal -> buys DOWN")

# ---- 4. signal that lands after +2s fires on the tick it is known
e = mk(signal=False); assert e.needs_signal()
tick(e, T + 3, 0.50, 0.50); assert e.s.position is None
e.set_signal(evaluate(UP_CLOSES), now=T + 5)
assert e.s.position is None                                     # armed, fires with the next tick's book
tick(e, T + 5, 0.50, 0.50, ul=[(0.50, 1000)]); assert e.s.position and e.s.position.entry_price == 0.50
print("4 ok: late signal -> fires the moment it is known")

# ---- 5. one entry per window: no second buy, and no re-entry after a TP
e = mk(UP_CLOSES); tick(e, T + 2, 0.50, 0.50); tick(e, T + 10, 0.40, 0.60); tick(e, T + 100, 0.30, 0.70)
assert e.total_taker_entries == 1 and e.s.position.shares == 300
e.on_tick(0.99, 1.0, 0.01, 0.02, 200, now=T + 120, up_bid_levels=[(0.99, 1000)])
assert e.s.position is None and e.total_tp_fills == 1
tick(e, T + 130, 0.40, 0.60); tick(e, T + 200, 0.30, 0.70)
assert e.s.position is None and e.total_taker_entries == 1
print("5 ok: one entry per window, no re-entry after TP")

# ---- 6. no ask / empty book: nothing invented, retries each tick, logs once, buys when depth appears
e = mk(UP_CLOSES)
tick(e, T + 2, None, 0.5, ul=[]); tick(e, T + 3, None, 0.5, ul=[]); tick(e, T + 4, 0.50, 0.5, ul=[])
assert e.s.position is None and e.total_illiquid_skips == 1 and ev(e).count("NO_LIQUIDITY") == 1
assert e.snapshot()["status"] == "entry_pending"
tick(e, T + 5, 0.55, 0.45, ul=[(0.55, 1000)])
assert e.s.position and e.s.position.entry_price == 0.55 and e.s.position.shares == 300
print("6 ok: empty book -> retries, no fake fill, buys when depth returns")

# ---- 7. never any depth -> ENTRY_MISSED at close, nothing spent
e = mk(UP_CLOSES)
tick(e, T + 2, None, None, ul=[]); tick(e, T + 200, None, None, ul=[])
e.finalize_window(Side.UP)
assert e.total_no_fills == 1 and "ENTRY_MISSED" in ev(e) and e.capital.balance == config.STARTING_CAPITAL
assert e.history[0]["result"] == "no fill (empty book)" and e.history[0]["entry"] is None
print("7 ok: no depth all window -> no trade, balance untouched")

# ---- 8. no entry at/after the window close
e = mk(UP_CLOSES); tick(e, T + 300, 0.50, 0.50); assert e.s.position is None
print("8 ok: nothing fires at/after the window close")

# ---- 9. no pattern / no data / late join -> nothing bought
e = mk(FLAT_CLOSES); assert e.s.signal_status == "no_pattern" and e.total_no_pattern == 1
tick(e, T + 2, 0.30, 0.30); tick(e, T + 200, 0.50, 0.50); assert e.s.position is None and e.snapshot()["entry"] is None
e = mk(signal=False); e.set_signal_unavailable("boom"); assert e.s.signal_status == "no_data"
tick(e, T + 5, 0.5, 0.5); assert e.s.position is None
e = mk(late=True); assert not e.needs_signal() and e.s.signal_status == "late_join"
tick(e, T + 200, 0.30, 0.30); assert e.s.position is None
print("9 ok: no pattern / no data / late join -> no buy")

# ---- 10. exits kept: TP (+) and forced window-end close (-)
e = mk(UP_CLOSES); tick(e, T + 2, 0.40, 0.60, ul=[(0.40, 1000)]); cost = e.s.position.cost
e.on_tick(0.99, 1.0, 0.01, 0.02, 200, now=T + 60, up_bid_levels=[(0.99, 1000)])
assert e.s.position is None and e.total_tp_fills == 1 and e.total_pnl > 0
assert abs(e.total_pnl - (300 * 0.99 - e.broker.taker_fee_amount(300, 0.99) - cost)) < 1e-9
e = mk(UP_CLOSES); tick(e, T + 2, 0.40, 0.60, ul=[(0.40, 1000)])
tick(e, T + 100, 0.30, 0.70, ub=0.20); e.finalize_window(Side.DOWN)
assert e.total_forced_closes == 1 and e.total_pnl < 0 and e.losses == 1
assert e.history[0]["result"] == "taker entry, forced close" and e.history[0]["entry"] == "taker"
print("10 ok: TP exit (+) and forced close (-)")

# ---- 11. signal accuracy tracking + history rows + JSON snapshot
e = mk(UP_CLOSES); e.finalize_window(Side.UP)
e2 = mk(DOWN_CLOSES); e2.finalize_window(Side.UP)
assert e.signal_right == 1 and e2.signal_wrong == 1
h = e.history[0]; assert h["signal"] == "UP" and h["winner"] == "UP" and h["closes"] == [100.0, 99.0, 99.8, 100.2, 100.5]
e3 = mk(UP_CLOSES); tick(e3, T + 2, 0.40, 0.60)
snap = e3.snapshot(); json.dumps(snap)
assert snap["signal"]["side"] == "UP" and snap["def"] == {"taker_shares": 300, "entry_delay_s": 2, "tp_price": 0.99}
assert "order" not in snap and snap["position"]["side"] == "UP"
print("11 ok: signal accuracy + history + JSON snapshot")
print("ALL PASSED")
