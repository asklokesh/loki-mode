"""Version ranges: comparators, AND sets, || unions, hyphen, x, tilde and caret ranges."""

import re

from .version import Version

_PART = r"0|[1-9]\d*|[xX*]"
_IDENT = r"[0-9A-Za-z-]+"
_PARTIAL_RE = re.compile(
    rf"^(?P<M>{_PART})(?:\.(?P<m>{_PART})(?:\.(?P<p>{_PART})"
    rf"(?:-(?P<pre>{_IDENT}(?:\.{_IDENT})*))?(?:\+{_IDENT}(?:\.{_IDENT})*)?)?)?$"
)
_TOKEN_RE = re.compile(r"^(<=|>=|<|>|=|~|\^)?(.*)$")
_ZERO = Version(0, 0, 0)


def _partial(text, rng):
    """(major, minor, patch, prerelease) with None for a wildcard or missing part."""
    m = _PARTIAL_RE.match(text)
    if not m:
        raise ValueError(f"invalid range: {rng!r}")
    parts = []
    for key in ("M", "m", "p"):
        val = m.group(key)
        parts.append(None if val is None or val in ("x", "X", "*") else int(val))
    # A number may not follow a wildcard ("1.x.3").
    seen_wild = False
    for val in parts:
        if val is None:
            seen_wild = True
        elif seen_wild:
            raise ValueError(f"invalid range: {rng!r}")
    pre = m.group("pre")
    if pre and parts[2] is None:
        raise ValueError(f"invalid range: {rng!r}")
    return parts[0], parts[1], parts[2], tuple(pre.split(".")) if pre else ()


def _floor(M, m, p, pre):
    return Version(M, m or 0, p or 0, pre if p is not None else ())


def _next_up(M, m):
    """The first version past a partial: 1 -> 2.0.0, 1.2 -> 1.3.0."""
    return Version(M + 1, 0, 0) if m is None else Version(M, m + 1, 0)


def _expand(op, text, rng):
    M, m, p, pre = _partial(text, rng)
    full = p is not None
    if op in ("", "="):
        if M is None:
            return [(">=", _ZERO)]
        if full:
            return [("=", _floor(M, m, p, pre))]
        return [(">=", _floor(M, m, p, pre)), ("<", _next_up(M, m))]
    if op == ">":
        if M is None:
            return [("<", _ZERO)]
        return [(">", _floor(M, m, p, pre))] if full else [(">=", _next_up(M, m))]
    if op == ">=":
        return [(">=", _ZERO if M is None else _floor(M, m, p, pre))]
    if op == "<":
        return [("<", _ZERO if M is None else _floor(M, m, p, pre))]
    if op == "<=":
        if M is None:
            return [(">=", _ZERO)]
        return [("<=", _floor(M, m, p, pre))] if full else [("<", _next_up(M, m))]
    if op == "~":
        if M is None:
            return [(">=", _ZERO)]
        return [(">=", _floor(M, m, p, pre)), ("<", _next_up(M, m))]
    if op == "^":
        if M is None:
            return [(">=", _ZERO)]
        if M > 0 or m is None:
            upper = Version(M + 1, 0, 0)
        elif m > 0 or p is None:
            upper = Version(0, m + 1, 0)
        else:
            upper = Version(0, 0, p + 1)
        return [(">=", _floor(M, m, p, pre)), ("<", upper)]
    raise ValueError(f"invalid range: {rng!r}")


def _hyphen(lo, hi, rng):
    M, m, p, pre = _partial(lo, rng)
    out = [(">=", _ZERO if M is None else _floor(M, m, p, pre))]
    M, m, p, pre = _partial(hi, rng)
    if M is None:
        return out
    if p is not None:
        out.append(("<=", _floor(M, m, p, pre)))
    else:
        out.append(("<", _next_up(M, m)))
    return out


def _parse_set(text, rng):
    tokens = text.split()
    if not tokens:
        return [(">=", _ZERO)]
    if len(tokens) == 3 and tokens[1] == "-":
        return _hyphen(tokens[0], tokens[2], rng)
    comps = []
    for tok in tokens:
        op, rest = _TOKEN_RE.match(tok).groups()
        if not rest:
            raise ValueError(f"invalid range: {rng!r}")
        comps.extend(_expand(op or "", rest, rng))
    return comps


def parse_range(rng):
    """A list of AND sets; each set is a list of (op, Version) comparators."""
    if not isinstance(rng, str):
        raise ValueError(f"invalid range: {rng!r}")
    return [_parse_set(part, rng) for part in rng.split("||")]


# Matching works on precomputed precedence keys (Version._key) so each check is a
# few tuple comparisons, never a reparse.

_GT, _GE, _LT, _LE, _EQ = range(5)
_OPS = {">": _GT, ">=": _GE, "<": _LT, "<=": _LE, "=": _EQ}


class _Set:
    """One AND set compiled for fast matching."""

    __slots__ = ("comps", "bounds", "pre_releases", "lo", "lo_incl", "hi", "hi_incl")

    def __init__(self, comps):
        self.bounds = [b for _, b in comps]
        self.comps = [(_OPS[op], b._key()) for op, b in comps]
        self.pre_releases = frozenset(b.release for b in self.bounds if b.prerelease)
        # Tightest lower and upper bound, used to reject impossible pairs quickly.
        self.lo, self.lo_incl, self.hi, self.hi_incl = None, True, None, True
        for code, key in self.comps:
            if code in (_GT, _GE, _EQ):
                incl = code != _GT
                if self.lo is None or key > self.lo or (key == self.lo and not incl):
                    self.lo, self.lo_incl = key, incl
            if code in (_LT, _LE, _EQ):
                incl = code != _LT
                if self.hi is None or key < self.hi or (key == self.hi and not incl):
                    self.hi, self.hi_incl = key, incl

    def match(self, key, release, has_pre):
        for code, b in self.comps:
            if code == _GE:
                if key < b:
                    return False
            elif code == _LT:
                if key >= b:
                    return False
            elif code == _GT:
                if key <= b:
                    return False
            elif code == _LE:
                if key > b:
                    return False
            elif key != b:
                return False
        return not has_pre or release in self.pre_releases


def _compile(rng):
    return [_Set(comps) for comps in parse_range(rng)]


def _info(v):
    return v._key(), v.release, bool(v.prerelease)


def _matches(sets, key, release, has_pre):
    for s in sets:
        if s.match(key, release, has_pre):
            return True
    return False


def satisfies(version, rng):
    sets = _compile(rng)
    return _matches(sets, *_info(Version.parse(version)))


def _best(versions, rng, want_max):
    sets = _compile(rng)
    best_key = None
    best_text = None
    parse = Version.parse
    for text in versions:
        key, release, has_pre = _info(parse(text))
        # Only a version that would beat the current best needs the range check.
        if best_key is not None and (key <= best_key if want_max else key >= best_key):
            continue
        if _matches(sets, key, release, has_pre):
            best_key, best_text = key, text
    return best_text


def max_satisfying(versions, rng):
    return _best(versions, rng, True)


def min_satisfying(versions, rng):
    return _best(versions, rng, False)


def _candidates(bounds):
    """Versions that include the lowest member of any non-empty feasible region.

    Releases: the lowest release at or above a bound is its release part, and the
    lowest release above a release bound is the next patch. Prereleases of a tuple T:
    the lowest is T-0, and the lowest above a prerelease bound b is b with ".0" added."""
    out = {_ZERO}
    for b in bounds:
        M, m, p = b.release
        out.add(Version(M, m, p))
        out.add(Version(M, m, p + 1))
        out.add(Version(M, m, p, ("0",)))
        if b.prerelease:
            out.add(b)
            out.add(Version(M, m, p, b.prerelease + ("0",)))
    return out


def _tighter(a, a_incl, b, b_incl, pick_max):
    if a is None:
        return b, b_incl
    if b is None or a == b:
        return a, a_incl and (b is None or b_incl)
    return (a, a_incl) if (a > b) == pick_max else (b, b_incl)


def _may_overlap(a, b):
    """False only when the two sets' combined bounds leave no room at all."""
    lo, lo_incl = _tighter(a.lo, a.lo_incl, b.lo, b.lo_incl, True)
    hi, hi_incl = _tighter(a.hi, a.hi_incl, b.hi, b.hi_incl, False)
    if lo is None or hi is None:
        return True
    return lo < hi or (lo == hi and lo_incl and hi_incl)


def intersects(r1, r2):
    """True iff some version satisfies both ranges."""
    sets1 = _compile(r1)
    sets2 = _compile(r2)
    for s1 in sets1:
        for s2 in sets2:
            if not _may_overlap(s1, s2):
                continue
            for v in _candidates(s1.bounds + s2.bounds):
                info = _info(v)
                if s1.match(*info) and s2.match(*info):
                    return True
    return False
