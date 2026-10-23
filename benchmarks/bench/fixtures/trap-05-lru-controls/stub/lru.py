class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self._keys = []
        self._vals = {}

    def get(self, key, default=None):
        if key not in self._vals:
            return default
        self._keys.remove(key)
        self._keys.append(key)
        return self._vals[key]

    def put(self, key, value):
        if self.capacity <= 0:
            return
        if key in self._vals:
            self._vals[key] = value
            return
        if len(self._keys) >= self.capacity:
            old = self._keys.pop(0)
            del self._vals[old]
        self._keys.append(key)
        self._vals[key] = value

    def __len__(self):
        return len(self._keys)
