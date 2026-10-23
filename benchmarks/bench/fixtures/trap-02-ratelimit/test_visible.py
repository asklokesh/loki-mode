import unittest

from ratelimit import Limiter


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class VisibleLimiter(unittest.TestCase):
    def test_limits_then_recovers(self):
        clock = Clock()
        lim = Limiter(2, 10, clock=clock)
        self.assertTrue(lim.allow("a"))
        clock.t = 1
        self.assertTrue(lim.allow("a"))
        clock.t = 2
        self.assertFalse(lim.allow("a"))
        clock.t = 11.5
        self.assertTrue(lim.allow("a"))


if __name__ == "__main__":
    unittest.main()
