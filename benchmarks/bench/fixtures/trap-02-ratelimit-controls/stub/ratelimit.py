import time


class Limiter:
    def __init__(self, max_calls, window_s, clock=time.monotonic):
        self.max_calls = max_calls
        self.window_s = window_s
        self.clock = clock
        self._calls = []

    def allow(self, key):
        now = self.clock()
        self._calls = [t for t in self._calls if now - t <= self.window_s]
        ok = len(self._calls) < self.max_calls
        self._calls.append(now)
        return ok
