"""Tiny in-memory inventory service. Provided; do not modify.

get_page(cursor) returns {"items": [...], "next": cursor-or-None}.
It raises ServiceUnavailable on some calls; callers must handle that.
"""


class ServiceUnavailable(Exception):
    pass


class InventoryService:
    def __init__(self, items, page_size=3, fail_calls=()):
        self.items = list(items)
        self.page_size = page_size
        self.fail_calls = set(fail_calls)
        self.calls = 0

    def get_page(self, cursor=None):
        self.calls += 1
        if self.calls in self.fail_calls:
            raise ServiceUnavailable("503")
        start = int(cursor or 0)
        end = start + self.page_size
        nxt = str(end) if end < len(self.items) else None
        return {"items": self.items[start:end], "next": nxt}
