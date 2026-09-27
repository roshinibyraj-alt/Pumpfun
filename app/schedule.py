"""Brisbane-local trading windows for the weekday and weekend paper bots."""
from datetime import datetime
from zoneinfo import ZoneInfo


BRISBANE = ZoneInfo("Australia/Brisbane")
WEEKDAY_SCHEDULE = "Mon 06:00–Fri 15:30 Brisbane"
WEEKEND_SCHEDULE = "Fri 18:00–Sun 22:00 Brisbane"


def session_for_timestamp(timestamp: float) -> str | None:
    """Return the strategy assigned to a market window's opening timestamp."""
    local = datetime.fromtimestamp(timestamp, BRISBANE)
    day = local.weekday()  # Monday = 0
    clock = local.time().replace(tzinfo=None)

    if day == 0 and clock.hour >= 6:
        return "weekday"
    if 1 <= day <= 3:
        return "weekday"
    if day == 4 and (clock.hour, clock.minute) < (15, 30):
        return "weekday"

    if day == 4 and (clock.hour, clock.minute) >= (18, 0):
        return "weekend"
    if day == 5:
        return "weekend"
    if day == 6 and (clock.hour, clock.minute) < (22, 0):
        return "weekend"

    return None


def session_status(timestamp: float) -> dict:
    """Describe both sessions for the dashboard at a point in time."""
    active = session_for_timestamp(timestamp)
    local = datetime.fromtimestamp(timestamp, BRISBANE)
    return {
        "timezone": "Australia/Brisbane",
        "local_time": local.isoformat(),
        "current": active,
        "weekday": {
            "active": active == "weekday",
            "schedule": WEEKDAY_SCHEDULE,
        },
        "weekend": {
            "active": active == "weekend",
            "schedule": WEEKEND_SCHEDULE,
        },
    }