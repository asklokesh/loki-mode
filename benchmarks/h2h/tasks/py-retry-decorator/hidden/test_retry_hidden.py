import pytest

from netutil.http import TransientError, fetch_json
from netutil.retry import retry


class Boom(Exception):
    pass


def recorder():
    delays = []
    return delays, delays.append


def test_succeeds_without_retry():
    delays, sleep = recorder()

    @retry(sleep=sleep)
    def ok():
        return 42

    assert ok() == 42
    assert delays == []


def test_retries_then_succeeds_with_backoff():
    delays, sleep = recorder()
    calls = []

    @retry(attempts=4, exceptions=(Boom,), base_delay=0.5, factor=3.0, sleep=sleep)
    def flaky(x):
        calls.append(x)
        if len(calls) < 4:
            raise Boom(len(calls))
        return x * 2

    assert flaky(5) == 10
    assert calls == [5, 5, 5, 5]
    assert delays == pytest.approx([0.5, 1.5, 4.5])


def test_gives_up_and_reraises_last_exception():
    delays, sleep = recorder()
    seen = []

    @retry(attempts=3, exceptions=(Boom,), base_delay=1, factor=2, sleep=sleep)
    def down():
        exc = Boom(len(seen) + 1)
        seen.append(exc)
        raise exc

    with pytest.raises(Boom) as info:
        down()
    assert info.value is seen[-1]
    assert len(seen) == 3
    assert delays == pytest.approx([1, 2])


def test_other_exceptions_propagate_immediately():
    delays, sleep = recorder()
    calls = []

    @retry(attempts=5, exceptions=(Boom,), sleep=sleep)
    def wrong():
        calls.append(1)
        raise KeyError("nope")

    with pytest.raises(KeyError):
        wrong()
    assert calls == [1]
    assert delays == []


def test_subclasses_are_retried():
    class SubBoom(Boom):
        pass

    delays, sleep = recorder()
    calls = []

    @retry(attempts=2, exceptions=(Boom,), sleep=sleep)
    def f():
        calls.append(1)
        if len(calls) == 1:
            raise SubBoom()
        return "ok"

    assert f() == "ok"
    assert len(delays) == 1


def test_preserves_metadata():
    @retry(sleep=lambda s: None)
    def documented(a, b=2):
        """Adds things."""
        return a + b

    assert documented.__name__ == "documented"
    assert documented.__doc__ == "Adds things."
    assert documented(1, b=3) == 4


def test_attempts_below_one_fails_at_decoration():
    with pytest.raises(ValueError):
        retry(attempts=0)
    with pytest.raises(ValueError):
        retry(attempts=-1)


def test_single_attempt_never_sleeps():
    delays, sleep = recorder()

    @retry(attempts=1, sleep=sleep)
    def f():
        raise Boom()

    with pytest.raises(Boom):
        f()
    assert delays == []


def test_fetch_json_behaviour_kept():
    delays, sleep = recorder()
    calls = []

    def flaky(url):
        calls.append(url)
        if len(calls) < 3:
            raise TransientError("503")
        return '{"n": 1}'

    assert fetch_json("http://x", flaky, sleep=sleep) == {"n": 1}
    assert delays == pytest.approx([0.5, 1.0])


def test_fetch_json_gives_up_after_three():
    delays, sleep = recorder()
    calls = []

    def down(url):
        calls.append(url)
        raise TransientError("timeout")

    with pytest.raises(TransientError):
        fetch_json("http://x", down, sleep=sleep)
    assert len(calls) == 3
    assert delays == pytest.approx([0.5, 1.0])


def test_fetch_json_does_not_retry_other_errors():
    calls = []

    def broken(url):
        calls.append(url)
        raise ValueError("bad")

    with pytest.raises(ValueError):
        fetch_json("http://x", broken, sleep=lambda s: None)
    assert len(calls) == 1


def test_fetch_json_uses_the_decorator_module():
    import inspect
    import re

    import netutil.http as http

    assert re.search(r"\bretry\(", inspect.getsource(http)), "fetch_json should call the retry decorator"
