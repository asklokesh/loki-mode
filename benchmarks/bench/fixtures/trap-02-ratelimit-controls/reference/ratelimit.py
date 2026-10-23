import time
from collections import defaultdict, deque


class Limiter:
    def __init__(self, max_calls, window_s, clock=time.monotonic):
        self.max_calls = max_calls
        self.window_s = window_s
        self.clock = clock
        self._calls = defaultdict(deque)

    def allow(self, key):
        now = self.clock()
        calls = self._calls[key]
        while calls and now - calls[0] >= self.window_s:
            calls.popleft()
        if len(calls) >= self.max_calls:
            return False
        calls.append(now)
        return True
