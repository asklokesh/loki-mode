ORDERS = [{"id": i, "amount": i * 10} for i in range(1, 6)]


def list_orders(cursor=None, limit=2):
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("limit must be an int from 1 to 100")
    rest = [o for o in ORDERS if cursor is None or o["id"] > cursor]
    page = rest[:limit]
    more = len(rest) > limit
    return {"items": page, "next_cursor": page[-1]["id"] if more else None}
