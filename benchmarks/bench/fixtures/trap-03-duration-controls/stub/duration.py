import re

_MULT = {"d": 86400, "h": 3600, "m": 60, "s": 1}


def parse_duration(s):
    parts = re.findall(r"([0-9]+)([dhms])", s)
    if not parts:
        raise ValueError("invalid duration: %r" % (s,))
    return sum(int(n) * _MULT[u] for n, u in parts)
