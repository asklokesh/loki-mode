# Test fixture for tests/test-pytest-gate-timeout.sh.
# Sleeps long enough that a 2s timeout will fire but a 15s timeout will not.
import time


def test_sleeping():
    time.sleep(10)
    assert True
