import re

_MULT = {"d": 86400, "h": 3600, "m": 60, "s": 1}


def parse_duration(text):
    if not isinstance(text, str):
        raise ValueError("text must be a string")
    s = text.strip().lower()
    if not s:
        raise ValueError("empty duration")
    pos, seen, total = 0, set(), 0
    comp = re.compile(r"(\d+)([a-z])\s*")
    while pos < len(s):
        m = comp.match(s, pos)
        if not m or m.group(2) not in _MULT or m.group(2) in seen:
            raise ValueError("bad duration: %r" % text)
        seen.add(m.group(2))
        total += int(m.group(1)) * _MULT[m.group(2)]
        pos = m.end()
    return total


def format_duration(seconds):
    if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds < 0:
        raise ValueError("seconds must be a non-negative int")
    if seconds == 0:
        return "0s"
    out = ""
    for unit in "dhms":
        q, seconds = divmod(seconds, _MULT[unit])
        if q:
            out += "%d%s" % (q, unit)
    return out
