from datetime import datetime, timezone

import pytest

from conftest import Clock
from integrations.ai.loader import BreakerSettings
from integrations.ai.router.breaker import Breaker
from integrations.ai.router.quota import Quota, QuotaExceeded, next_reset, window_start
from integrations.ai.router.store import StateStore


def utc(*parts):
    return datetime(*parts, tzinfo=timezone.utc).timestamp()


@pytest.mark.parametrize("reset,tz,hour,now,expected", [
    ("daily", "UTC", 0, utc(2026, 11, 3, 15, 30), utc(2026, 11, 3)),
    ("daily", "UTC", 6, utc(2026, 11, 3, 5, 0), utc(2026, 11, 2, 6)),
    ("daily", "Europe/Paris", 0, utc(2026, 11, 3, 23, 30), utc(2026, 11, 3, 23)),
    ("daily", "Europe/Paris", 0, utc(2026, 11, 3, 22, 59), utc(2026, 11, 2, 23)),
    ("daily", "America/Los_Angeles", 0, utc(2026, 11, 3, 7, 59), utc(2026, 11, 2, 8)),
    ("daily", "America/Los_Angeles", 0, utc(2026, 11, 3, 8, 0), utc(2026, 11, 3, 8)),
    ("daily", "Asia/Shanghai", 0, utc(2026, 11, 3, 15, 59), utc(2026, 11, 2, 16)),
    ("daily", "Asia/Shanghai", 0, utc(2026, 11, 3, 16, 0), utc(2026, 11, 3, 16)),
    ("weekly", "UTC", 0, utc(2026, 11, 4, 12), utc(2026, 11, 1)),
    ("weekly", "UTC", 0, utc(2026, 11, 7, 23, 59), utc(2026, 11, 1)),
    ("weekly", "UTC", 0, utc(2026, 11, 8), utc(2026, 11, 8)),
    ("monthly", "UTC", 0, utc(2026, 12, 31, 23, 59), utc(2026, 12, 1)),
    ("monthly", "UTC", 0, utc(2027, 1, 1), utc(2027, 1, 1)),
    ("monthly", "Europe/Paris", 0, utc(2026, 11, 30, 23, 30), utc(2026, 11, 30, 23)),
    ("never", "UTC", 0, utc(2026, 11, 3), 0.0),
    ("continuous", "UTC", 0, utc(2026, 11, 3), None),
])
def test_quota_window_start_for_each_timezone_returns_the_exact_reset_instant(reset, tz, hour, now, expected):
    # Arrange: parameters above. Act
    start = window_start(now, reset, tz, hour)
    # Assert
    assert start == expected


def test_quota_next_reset_across_daily_weekly_monthly_and_dst_returns_the_following_window():
    # Arrange / Act / Assert
    assert next_reset(utc(2026, 11, 3, 15), "daily", "UTC", 0) == utc(2026, 11, 4)
    assert next_reset(utc(2026, 11, 4), "weekly", "UTC", 0) == utc(2026, 11, 8)
    assert next_reset(utc(2026, 12, 15), "monthly", "UTC", 0) == utc(2027, 1, 1)
    assert next_reset(utc(2026, 11, 3), "never", "UTC", 0) is None and next_reset(utc(2026, 11, 3), "continuous", "UTC", 0) is None
    start = window_start(utc(2026, 10, 25, 10), "daily", "Europe/Paris", 0)  # the day clocks go back: 25 hours long
    assert next_reset(utc(2026, 10, 25, 10), "daily", "Europe/Paris", 0) - start == 25 * 3600


@pytest.fixture()
def spec(registry):
    return registry.get("groq").model_copy(deep=True)


def test_quota_rpm_sliding_window_refuses_then_accepts_after_sixty_seconds(spec):
    # Arrange
    clock, spec.limits.rpm = Clock(), 2
    quota = Quota(StateStore(None), clock)
    quota.check(spec, reserve=True)
    quota.check(spec, reserve=True)
    # Act
    with pytest.raises(QuotaExceeded) as refused:
        quota.check(spec, reserve=True)
    clock.advance(61)
    quota.check(spec, reserve=True)
    # Assert
    assert refused.value.reset_in == pytest.approx(60, abs=1)


def test_quota_daily_request_cap_excludes_provider_until_the_reset_hour(spec):
    # Arrange: groq resets at 00:00 UTC
    clock, spec.limits.rpd = Clock(utc(2026, 11, 3, 23, 59, 30)), 2
    quota = Quota(StateStore(None), clock)
    quota.check(spec, reserve=True)
    quota.check(spec, reserve=True)
    # Act
    with pytest.raises(QuotaExceeded) as refused:
        quota.check(spec, reserve=True)
    clock.advance(31)  # 00:00:01 the next day
    quota.check(spec, reserve=True)
    # Assert
    assert refused.value.reset_in == pytest.approx(30, abs=1) and quota.snapshot(spec)["limits"]["requests"]["used"] == 1


def test_quota_token_and_unit_caps_count_tokens_before_the_call_and_release_gives_them_back(registry):
    # Arrange
    spec = registry.get("elevenlabs").model_copy(deep=True)
    spec.limits.unit_cap = 10000
    quota = Quota(StateStore(None), Clock())
    quota.check(spec, units=9000, reserve=True)
    # Act
    with pytest.raises(QuotaExceeded):
        quota.check(spec, units=2000, reserve=True)
    quota.release(spec, units=9000)
    quota.check(spec, units=2000, reserve=True)
    # Assert
    assert quota.snapshot(spec)["limits"]["characters"]["used"] == 2000


def test_quota_adjust_replaces_the_estimate_by_the_measured_usage(spec):
    # Arrange
    spec.limits.tpd, quota = 1000, Quota(StateStore(None), Clock())
    quota.check(spec, tokens=100, reserve=True)
    # Act
    quota.adjust(spec, 100, 700)
    # Assert
    with pytest.raises(QuotaExceeded):
        quota.check(spec, tokens=400)
    quota.check(spec, tokens=300)


def test_quota_mark_exhausted_blocks_for_the_given_delay_only(spec):
    # Arrange
    clock = Clock()
    quota = Quota(StateStore(None), clock)
    # Act
    quota.mark_exhausted(spec, 120)
    blocked = quota.exhausted(spec)
    clock.advance(121)
    # Assert
    assert blocked is True and quota.exhausted(spec) is False


def test_quota_state_survives_a_restart(spec, tmp_path):
    # Arrange
    path, clock, spec.limits.rpd = tmp_path / "state.json", Clock(), 1
    Quota(StateStore(path), clock).check(spec, reserve=True)
    # Act
    reborn = Quota(StateStore(path), clock)
    # Assert
    with pytest.raises(QuotaExceeded):
        reborn.check(spec)


SETTINGS = BreakerSettings(failures=3, cooldown_s=60, max_backoff_s=900)


def test_breaker_three_consecutive_failures_open_it_for_sixty_seconds():
    # Arrange
    clock = Clock()
    breaker = Breaker(SETTINGS, StateStore(None), clock)
    # Act
    breaker.record_failure("p")
    breaker.record_failure("p")
    still_closed = breaker.allow("p")
    breaker.record_failure("p")
    # Assert
    assert still_closed and not breaker.allow("p") and breaker.cooldown_remaining("p") == pytest.approx(60)
    clock.advance(61)
    assert breaker.allow("p")


def test_breaker_reopening_doubles_the_cooldown_up_to_the_fifteen_minute_cap():
    # Arrange
    clock = Clock()
    breaker = Breaker(SETTINGS, StateStore(None), clock)
    for _ in range(3):
        breaker.record_failure("p")
    delays = []
    # Act: each failure after a cooldown reopens it at once, with a longer delay
    for _ in range(6):
        clock.advance(breaker.cooldown_remaining("p") + 1)
        breaker.record_failure("p")
        delays.append(round(breaker.cooldown_remaining("p")))
    # Assert
    assert delays == [120, 240, 480, 900, 900, 900]


def test_breaker_success_closes_it_and_forgets_the_failures():
    # Arrange
    breaker = Breaker(SETTINGS, StateStore(None), Clock())
    for _ in range(3):
        breaker.record_failure("p")
    # Act
    breaker.record_success("p")
    # Assert
    assert breaker.allow("p") and breaker.info("p")["failures"] == 0


def test_breaker_rejected_key_opens_it_at_the_maximum_and_a_new_key_resets_it():
    # Arrange
    clock = Clock()
    breaker = Breaker(SETTINGS, StateStore(None), clock)
    breaker.sync_key("p", "old-key-123456")
    # Act
    breaker.record_failure("p", "HTTP 401", hard=True, invalid_key=True)
    blocked = (breaker.allow("p"), breaker.cooldown_remaining("p"), breaker.info("p")["invalid_key"])
    breaker.sync_key("p", "new-key-123456")
    # Assert
    assert blocked == (False, 900, True) and breaker.allow("p") and not breaker.info("p")["invalid_key"]


def test_breaker_state_is_persisted_across_restarts(tmp_path):
    # Arrange
    path, clock = tmp_path / "state.json", Clock()
    first = Breaker(SETTINGS, StateStore(path), clock)
    first.sync_key("p", "key-1234567890")
    for _ in range(3):
        first.record_failure("p", "boom")
    # Act
    reborn = Breaker(SETTINGS, StateStore(path), clock)
    # Assert
    assert not reborn.allow("p") and reborn.info("p")["last_error"] == "boom"
