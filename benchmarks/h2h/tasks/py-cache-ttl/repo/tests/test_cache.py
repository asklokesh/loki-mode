import pytest

from cachelib import Cache


def test_get_and_set():
    c = Cache()
    c.set("a", 1)
    assert c.get("a") == 1
    assert c.get("missing", "dflt") == "dflt"


def test_lru_eviction():
    c = Cache(max_size=2)
    c.set("a", 1)
    c.set("b", 2)
    c.get("a")
    c.set("c", 3)
    assert "b" not in c
    assert "a" in c and "c" in c


def test_delete_and_len():
    c = Cache()
    c.set("a", 1)
    assert len(c) == 1
    assert c.delete("a") is True
    assert c.delete("a") is False
    assert len(c) == 0


def test_bad_size():
    with pytest.raises(ValueError):
        Cache(max_size=0)
