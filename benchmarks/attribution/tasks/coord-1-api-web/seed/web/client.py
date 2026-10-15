from api.orders import list_orders


def fetch_all_orders():
    return list_orders()["orders"]


def total_amount():
    return sum(o["amount"] for o in fetch_all_orders())
