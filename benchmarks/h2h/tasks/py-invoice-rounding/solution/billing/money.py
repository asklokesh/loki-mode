"""Money helpers. All internal amounts are integer cents."""

from decimal import ROUND_HALF_UP, Decimal


def to_cents(amount):
    """Convert a currency amount such as 19.99 to integer cents.

    The amount is read as the decimal value it is written as (str() of a float),
    never its binary approximation, and rounded half up to the nearest cent."""
    value = amount if isinstance(amount, Decimal) else Decimal(str(amount))
    return int((value * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def format_cents(cents):
    """Render integer cents as a plain decimal string, e.g. 1999 -> '19.99'."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
