import re

_PATTERN = re.compile(r"(?:([0-9]+)d)?(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s)?")
_SECONDS = (86400, 3600, 60, 1)


def parse_duration(s):
    m = _PATTERN.fullmatch(s)
    if m is None or not s:
        raise ValueError("invalid duration: %r" % (s,))
    return sum(int(g) * mult for g, mult in zip(m.groups(), _SECONDS) if g is not None)
