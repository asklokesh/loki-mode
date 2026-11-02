"""Money helpers. All internal amounts are integer cents."""


def to_cents(amount):
    """Convert a currency amount such as 19.99 to integer cents."""
    return int(amount * 100)


def format_cents(cents):
    """Render integer cents as a plain decimal string, e.g. 1999 -> '19.99'."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
