ORDERS = [{"id": i, "amount": i * 10} for i in range(1, 6)]


def list_orders():
    return {"orders": list(ORDERS), "total": len(ORDERS)}
