def avg(xs):
    """Mean of xs, 0.0 when empty."""
    if not xs:
        return 0.0
    return sum(xs) / len(xs)
