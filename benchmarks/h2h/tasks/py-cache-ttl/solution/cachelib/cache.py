"""An in-process LRU cache with optional expiry."""

import time
from collections import OrderedDict
from typing import Any, Callable, Hashable, Optional


def _check_ttl(ttl: Optional[float]) -> None:
    if ttl is not None and ttl <= 0:
        raise ValueError("ttl must be positive")


class Cache:
    def __init__(self, max_size: int = 128, ttl: Optional[float] = None, clock: Callable[[], float] = time.monotonic):
        if max_size < 1:
            raise ValueError("max_size must be at least 1")
        _check_ttl(ttl)
        self.max_size = max_size
        self.ttl = ttl
        self.clock = clock
        self._data: "OrderedDict[Hashable, tuple[Any, Optional[float]]]" = OrderedDict()

    def _expired(self, key: Hashable) -> bool:
        expires = self._data[key][1]
        return expires is not None and self.clock() >= expires

    def _purge(self) -> None:
        for key in [k for k in self._data if self._expired(k)]:
            del self._data[key]

    def get(self, key: Hashable, default: Any = None) -> Any:
        if key not in self:
            return default
        self._data.move_to_end(key)
        return self._data[key][0]

    def set(self, key: Hashable, value: Any, ttl: Optional[float] = None) -> None:
        _check_ttl(ttl)
        life = ttl if ttl is not None else self.ttl
        expires = None if life is None else self.clock() + life
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = (value, expires)
        if len(self._data) > self.max_size:
            self._purge()
        while len(self._data) > self.max_size:
            self._data.popitem(last=False)

    def delete(self, key: Hashable) -> bool:
        present = key in self
        self._data.pop(key, None)
        return present

    def __contains__(self, key: Hashable) -> bool:
        if key not in self._data:
            return False
        if self._expired(key):
            del self._data[key]
            return False
        return True

    def __len__(self) -> int:
        self._purge()
        return len(self._data)
