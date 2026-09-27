import asyncio
import unittest
from datetime import datetime

from app import config
from app.engine import Engine
from app.fees import crypto_taker_fee, estimated_maker_rebate
from app.models import (
    CapitalPool,
    OrderStatus,
    Outcome,
    RungOrders,
    RungState,
    Side,
    SimOrder,
    WindowState,
)
from app.schedule import BRISBANE, session_for_timestamp


def brisbane_timestamp(year, month, day, hour, minute, second=0):
    return datetime(
        year, month, day, hour, minute, second, tzinfo=BRISBANE
    ).timestamp()


class StrategyScheduleTests(unittest.TestCase):
    def test_weekday_boundaries_are_inclusive_at_open_and_exclusive_at_close(self):
        self.assertIsNone(session_for_timestamp(brisbane_timestamp(2026, 9, 28, 5, 59, 59)))
        self.assertEqual(session_for_timestamp(brisbane_timestamp(2026, 9, 28, 6, 0)), "weekday")
        self.assertEqual(session_for_timestamp(brisbane_timestamp(2026, 10, 2, 15, 29, 59)), "weekday")
        self.assertIsNone(session_for_timestamp(brisbane_timestamp(2026, 10, 2, 15, 30)))

    def test_weekend_boundaries_are_inclusive_at_open_and_exclusive_at_close(self):
        self.assertIsNone(session_for_timestamp(brisbane_timestamp(2026, 10, 2, 17, 59, 59)))
        self.assertEqual(session_for_timestamp(brisbane_timestamp(2026, 10, 2, 18, 0)), "weekend")
        self.assertEqual(session_for_timestamp(brisbane_timestamp(2026, 10, 4, 23, 59, 59)), "weekend")
        self.assertEqual(session_for_timestamp(brisbane_timestamp(2026, 10, 5, 4, 59, 59)), "weekend")
        self.assertIsNone(session_for_timestamp(brisbane_timestamp(2026, 10, 5, 5, 0)))

    def test_reverse_thresholds_pair_in_order_with_weekday_rungs(self):
        self.assertEqual(config.REVERSE_RUNG_PRICES, [0.60, 0.65, 0.70, 0.75])
        self.assertEqual(
            [round(1 - weekend, 2) for weekend in config.REVERSE_RUNG_PRICES],
            config.RUNG_PRICES,
        )


class FeeAndCapitalTests(unittest.TestCase):
    def test_crypto_taker_fees_match_documented_curve(self):
        self.assertEqual(crypto_taker_fee(500, 0.60), 8.4)
        self.assertEqual(crypto_taker_fee(500, 0.65), 7.9625)
        self.assertEqual(crypto_taker_fee(500, 0.70), 7.35)
        self.assertEqual(crypto_taker_fee(500, 0.75), 6.5625)

    def test_maker_rebate_is_an_explicit_estimate_not_a_direct_pool_payout(self):
        self.assertEqual(estimated_maker_rebate(500, 0.60), 1.68)

    def test_pair_capital_is_shared_but_strategy_stats_and_sizes_are_independent(self):
        pool = CapitalPool(pair_price=0.40)
        weekday = RungState(0.40, 0.40, "weekday", pool)
        weekend = RungState(0.60, 0.40, "weekend", pool)

        weekday.record_fill_outcome(
            "weekday-window",
            Side.UP,
            500,
            Outcome.WIN,
            1.0,
            entry_price=0.40,
            maker_rebate_estimate=1.68,
        )
        weekend.record_fill_outcome(
            "weekend-window",
            Side.UP,
            500,
            Outcome.LOSS,
            2.0,
            entry_price=0.60,
            fee_usd=8.40,
        )

        self.assertAlmostEqual(pool.capital_balance, 4991.60)
        self.assertAlmostEqual(weekday.total_pnl, 300.00)
        self.assertAlmostEqual(weekend.total_pnl, -308.40)
        self.assertAlmostEqual(weekday.total_maker_rebate_estimate, 1.68)
        self.assertEqual((weekday.wins, weekday.losses), (1, 0))
        self.assertEqual((weekend.wins, weekend.losses), (0, 1))
        self.assertEqual((weekday.current_size, weekend.current_size), (400, 500))


class FakePriceClient:
    def __init__(self, up_price, down_price):
        self.prices = {"up-token": up_price, "down-token": down_price}

    async def get_price(self, token_id, side="buy"):
        return self.prices[token_id]


class FillSimulationTests(unittest.TestCase):
    def make_engine(self, up_price, down_price):
        engine = Engine()
        engine.client = FakePriceClient(up_price, down_price)
        return engine

    def test_weekend_trigger_simulates_market_buy_and_cancels_opposite_side(self):
        engine = self.make_engine(0.62, 0.38)
        # Tracking balance is informational and must never block a fill.
        engine.capital_pools[0.40].capital_balance = -1000
        window = WindowState(
            slug="weekend-test",
            start_ts=1000,
            end_ts=1300,
            up_token_id="up-token",
            down_token_id="down-token",
            strategy="weekend",
        )

        asyncio.run(engine._process_window(window, 1001))

        rung = window.rungs[0.60]
        self.assertEqual(rung.up.status, OrderStatus.FILLED)
        self.assertEqual(rung.down.status, OrderStatus.CANCELLED)
        self.assertEqual(rung.up.fill_price, 0.62)
        self.assertEqual(rung.up.fee_usd, crypto_taker_fee(500, 0.62))
        self.assertEqual(window.rungs[0.65].up.status, OrderStatus.PENDING)
        self.assertIn("0.60", window.to_dict()["rungs"])

    def test_weekday_limit_fill_still_cancels_the_opposite_side(self):
        engine = self.make_engine(0.34, 0.90)
        window = WindowState(
            slug="weekday-test",
            start_ts=1000,
            end_ts=1300,
            up_token_id="up-token",
            down_token_id="down-token",
            strategy="weekday",
        )

        asyncio.run(engine._process_window(window, 1001))

        rung = window.rungs[0.40]
        self.assertEqual(rung.up.status, OrderStatus.FILLED)
        self.assertEqual(rung.down.status, OrderStatus.CANCELLED)
        self.assertEqual(rung.up.fill_price, 0.40)
        self.assertGreater(rung.up.maker_rebate_estimate, 0)

    def test_snapshot_reports_combined_capital_and_per_rung_unrealized_pnl(self):
        engine = self.make_engine(0.50, 0.50)
        window = WindowState(
            slug="weekday-open-position",
            start_ts=1000,
            end_ts=1300,
            up_token_id="up-token",
            down_token_id="down-token",
            strategy="weekday",
            last_up_price=0.50,
            last_down_price=0.50,
        )
        window.rungs[0.40] = RungOrders(
            up=SimOrder(
                side=Side.UP,
                price=0.40,
                size=100,
                status=OrderStatus.FILLED,
                fill_price=0.40,
                fee_usd=1.0,
            ),
            down=SimOrder(side=Side.DOWN, price=0.60, size=100),
            filled_side=Side.UP,
        )
        engine.active_windows[window.slug] = window

        snapshot = engine.snapshot()
        weekday_rung = next(
            rung for rung in snapshot["strategies"]["weekday"]["rungs"]
            if rung["price"] == 0.40
        )
        aggregate = snapshot["aggregate"]

        self.assertEqual(weekday_rung["unrealized_pnl"], 9.0)
        self.assertEqual(weekday_rung["win_rate"], 0.0)
        self.assertEqual(weekday_rung["capital_balance"], 5000.0)
        self.assertEqual(
            aggregate["combined_capital"],
            round(aggregate["total_capital"] + aggregate["floating_pnl"], 2),
        )


if __name__ == "__main__":
    unittest.main()