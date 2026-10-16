def summarize(cart):
    total = sum(cart)
    return {'total': total, 'per_item': total / len(cart) if cart else 0.0}
