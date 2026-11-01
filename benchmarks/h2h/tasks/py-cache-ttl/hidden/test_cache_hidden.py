import pytest

from cachelib import Cache


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def test_no_ttl_never_expires():
    clock = FakeClock()
    c = Cache(clock=clock)
    c.set("a", 1)
    clock.advance(10**6)
    assert c.get("a") == 1


def test_default_ttl_expires():
    clock = FakeClock()
    c = Cache(ttl=10, clock=clock)
    c.set("a", 1)
    clock.advance(9)
    assert c.get("a") == 1
    clock.advance(1)
    assert c.get("a", "gone") == "gone"


def test_expired_entry_is_gone_everywhere():
    clock = FakeClock()
    c = Cache(ttl=5, clock=clock)
    c.set("a", 1)
    c.set("b", 2, ttl=100)
    clock.advance(6)
    assert "a" not in c
    assert "b" in c
    assert len(c) == 1
    assert c.delete("a") is False
    assert c.delete("b") is True


def test_per_entry_ttl_overrides_default():
    clock = FakeClock()
    c = Cache(ttl=100, clock=clock)
    c.set("short", 1, ttl=1)
    c.set("long", 2)
    clock.advance(2)
    assert c.get("short") is None
    assert c.get("long") == 2


def test_per_entry_ttl_without_default():
    clock = FakeClock()
    c = Cache(clock=clock)
    c.set("a", 1, ttl=3)
    c.set("b", 2)
    clock.advance(3)
    assert "a" not in c
    assert c.get("b") == 2


def test_set_refreshes_lifetime():
    clock = FakeClock()
    c = Cache(ttl=10, clock=clock)
    c.set("a", 1)
    clock.advance(8)
    c.set("a", 2)
    clock.advance(8)
    assert c.get("a") == 2


def test_expired_evicted_before_lru():
    clock = FakeClock()
    c = Cache(max_size=2, clock=clock)
    c.set("old_live", 1)
    c.set("doomed", 2, ttl=1)
    clock.advance(2)
    c.set("new", 3)
    assert c.get("old_live") == 1
    assert c.get("new") == 3


def test_lru_still_works_with_ttl():
    clock = FakeClock()
    c = Cache(max_size=2, ttl=100, clock=clock)
    c.set("a", 1)
    c.set("b", 2)
    c.get("a")
    c.set("c", 3)
    assert "b" not in c
    assert c.get("a") == 1 and c.get("c") == 3


def test_invalid_ttl():
    with pytest.raises(ValueError):
        Cache(ttl=0)
    with pytest.raises(ValueError):
        Cache(ttl=-5)
    c = Cache()
    with pytest.raises(ValueError):
        c.set("a", 1, ttl=0)


def test_default_clock_works():
    c = Cache(ttl=60)
    c.set("a", 1)
    assert c.get("a") == 1
