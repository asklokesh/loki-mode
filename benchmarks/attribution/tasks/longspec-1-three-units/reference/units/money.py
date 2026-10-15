_SYMBOLS = {"USD": "$", "EUR": "EUR ", "GBP": "GBP "}


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def format_cents(cents, currency="USD"):
    if not _is_int(cents):
        raise TypeError("cents must be an int")
    if currency not in _SYMBOLS:
        raise ValueError("unsupported currency")
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), 100)
    return "%s%s%s.%02d" % (sign, _SYMBOLS[currency], format(whole, ","), frac)


def split_cents(total, parts):
    if not _is_int(parts) or parts < 1 or not _is_int(total) or total < 0:
        raise ValueError("bad total or parts")
    base, extra = divmod(total, parts)
    return [base + 1 if i < extra else base for i in range(parts)]
