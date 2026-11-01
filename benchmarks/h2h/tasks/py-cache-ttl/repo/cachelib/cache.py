"""An in-process LRU cache."""

from collections import OrderedDict
from typing import Any, Hashable


class Cache:
    def __init__(self, max_size: int = 128):
        if max_size < 1:
            raise ValueError("max_size must be at least 1")
        self.max_size = max_size
        self._data: "OrderedDict[Hashable, Any]" = OrderedDict()

    def get(self, key: Hashable, default: Any = None) -> Any:
        if key not in self._data:
            return default
        self._data.move_to_end(key)
        return self._data[key]

    def set(self, key: Hashable, value: Any) -> None:
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = value
        while len(self._data) > self.max_size:
            self._data.popitem(last=False)

    def delete(self, key: Hashable) -> bool:
        return self._data.pop(key, _MISSING) is not _MISSING

    def __contains__(self, key: Hashable) -> bool:
        return key in self._data

    def __len__(self) -> int:
        return len(self._data)


_MISSING = object()
