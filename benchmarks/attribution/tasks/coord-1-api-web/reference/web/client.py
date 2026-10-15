from api.orders import list_orders


def fetch_all_orders():
    out, cursor = [], None
    while True:
        page = list_orders(cursor=cursor)
        out.extend(page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            return out


def total_amount():
    return sum(o["amount"] for o in fetch_all_orders())
