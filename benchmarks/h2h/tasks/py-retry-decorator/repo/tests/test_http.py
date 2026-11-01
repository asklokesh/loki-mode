import pytest

from netutil.http import TransientError, fetch_json


def test_fetch_json_parses_body():
    assert fetch_json("u", lambda url: '{"ok": true}', sleep=lambda s: None) == {"ok": True}


def test_fetch_json_retries_transient_errors():
    calls = []

    def flaky(url):
        calls.append(url)
        if len(calls) < 3:
            raise TransientError("503")
        return "[1]"

    assert fetch_json("u", flaky, sleep=lambda s: None) == [1]
    assert len(calls) == 3


def test_fetch_json_gives_up():
    def down(url):
        raise TransientError("timeout")

    with pytest.raises(TransientError):
        fetch_json("u", down, sleep=lambda s: None)
