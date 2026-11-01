import time

import pytest

from semverlite.range import intersects, max_satisfying, min_satisfying, satisfies


def big_versions():
    """200000 distinct versions in a scrambled order; every 7th carries an -rc.N tag."""
    out = []
    for j in range(200000):
        i = (j * 7919) % 200000
        v = f"{i % 1000}.{(i // 1000) % 20}.{i // 20000}"
        if i % 7 == 3:
            v += f"-rc.{i % 5}"
        out.append(v)
    return out


# 50 OR sets: 48 narrow release windows plus two sets that admit specific prereleases.
BIG_RANGE = " || ".join(
    [f">={k * 20 + 3}.5.0 <{k * 20 + 3}.7.0" for k in range(48)]
    + [">=994.4.7-rc.1 <994.4.7", ">=1.0.2-rc.0 <=1.0.2"]
)

# 300-set OR ranges for intersects.
WIN_A = " || ".join(f">={k}.1.0 <{k}.2.0" for k in range(300))
WIN_B = " || ".join(f">={k}.2.0 <{k}.3.0" for k in range(300))
WIN_B_LAST = " || ".join([f">={k}.2.0 <{k}.3.0" for k in range(299)] + ["~299.1.5"])
WIN_C = " || ".join(f"{k}.2.0-rc.1 - {k}.2.0-rc.9" for k in range(300))


def check(rng, yes, no):
    for v in yes:
        assert satisfies(v, rng), f"{v} should satisfy {rng!r}"
    for v in no:
        assert not satisfies(v, rng), f"{v} should not satisfy {rng!r}"


def meet(r1, r2, expected):
    assert intersects(r1, r2) is expected, f"intersects({r1!r}, {r2!r}) should be {expected}"
    assert intersects(r2, r1) is expected, f"intersects({r2!r}, {r1!r}) should be {expected}"


def test_comparators_and_sets_or_sets():
    check(">=1.2.0 <1.3.0", ["1.2.0", "1.2.9"], ["1.1.9", "1.3.0"])
    check("1.2.3", ["1.2.3"], ["1.2.4"])
    check("=1.2.3", ["1.2.3"], ["1.2.2"])
    check(">1.2.3", ["1.2.4"], ["1.2.3"])
    check("<=1.2.3", ["1.2.3", "0.0.1"], ["1.2.4"])
    check("1.2.7 || >=1.2.9 <2.0.0", ["1.2.7", "1.2.9", "1.9.0"], ["1.2.8", "2.0.0", "1.2.6"])
    check("<1.0.0 || >=3.0.0", ["0.9.9", "3.0.0"], ["1.0.0", "2.9.9"])


def test_x_ranges_and_partials():
    check("1.x", ["1.0.0", "1.9.9"], ["0.9.9", "2.0.0"])
    check("1.2.*", ["1.2.0", "1.2.99"], ["1.1.9", "1.3.0"])
    check("1", ["1.0.0", "1.5.2"], ["2.0.0"])
    check("*", ["0.0.0", "99.1.0"], [])
    check("", ["0.0.0", "5.0.0"], [])
    check(">1.2", ["1.3.0"], ["1.2.9"])
    check(">1", ["2.0.0"], ["1.9.9"])
    check(">=1.2", ["1.2.0"], ["1.1.9"])
    check("<1.2", ["1.1.9"], ["1.2.0"])
    check("<=1.2", ["1.2.9"], ["1.3.0"])
    check("<=1", ["1.9.9"], ["2.0.0"])


def test_hyphen_ranges():
    check("1.2.3 - 2.3.4", ["1.2.3", "2.3.4"], ["1.2.2", "2.3.5"])
    check("1.2 - 2.3", ["1.2.0", "2.3.9"], ["1.1.9", "2.4.0"])
    check("1 - 2", ["1.0.0", "2.9.9"], ["0.9.9", "3.0.0"])


def test_tilde_and_caret():
    check("~1.2.3", ["1.2.3", "1.2.9"], ["1.2.2", "1.3.0"])
    check("~1.2", ["1.2.0", "1.2.9"], ["1.3.0"])
    check("~1", ["1.0.0", "1.9.9"], ["2.0.0"])
    check("~0.2.3", ["0.2.3", "0.2.9"], ["0.3.0"])
    check("^1.2.3", ["1.2.3", "1.9.9"], ["1.2.2", "2.0.0"])
    check("^1.x", ["1.0.0", "1.5.0"], ["0.9.9", "2.0.0"])


def test_caret_zero_major_and_minor():
    check("^0.2.3", ["0.2.3", "0.2.9"], ["0.2.2", "0.3.0"])
    check("^0.0.3", ["0.0.3"], ["0.0.2", "0.0.4"])
    check("^0.x", ["0.0.0", "0.9.0"], ["1.0.0"])
    check("^0.0", ["0.0.0", "0.0.9"], ["0.1.0"])


def test_prerelease_rule():
    check(">1.2.3-alpha.3", ["1.2.3-alpha.7", "1.2.3", "3.4.5"], ["3.4.5-alpha.9", "1.2.3-alpha.1"])
    check("*", [], ["1.0.0-beta"])
    check("1.x", [], ["1.1.0-rc.1"])
    check("<2.0.0", ["1.9.9"], ["2.0.0-rc.1"])
    check("^1.2.3-beta.2", ["1.2.3-beta.4", "1.2.3", "1.5.0"], ["1.2.3-beta.1", "1.2.4-beta.1"])
    check("1.2.3-beta", ["1.2.3-beta"], ["1.2.3"])
    check("1.2.3-alpha.1 || ^1.0.0", ["1.2.3-alpha.1", "1.5.0"], ["1.5.0-alpha", "1.2.3-alpha.2"])


def test_max_and_min_satisfying():
    vs = ["1.3.0", "1.2.4", "2.0.0", "1.2.3"]
    assert max_satisfying(vs, "~1.2.0") == "1.2.4"
    assert max_satisfying(vs, "^1.0.0") == "1.3.0"
    assert max_satisfying(vs, ">=3") is None
    assert max_satisfying([], "*") is None
    assert max_satisfying(["1.0.0", "1.1.0-rc.1"], "^1.0.0") == "1.0.0"
    assert max_satisfying(["1.0.0-rc.1", "1.0.0-rc.10", "1.0.0-rc.2"], ">=1.0.0-rc.1") == "1.0.0-rc.10"
    assert min_satisfying(vs, "~1.2.0") == "1.2.3"
    assert min_satisfying(vs, ">1.2.3") == "1.2.4"
    assert min_satisfying(vs, "<1") is None
    assert min_satisfying(["1.0.1", "1.0.0-rc.1", "1.0.0"], "^1.0.0") == "1.0.0"
    assert min_satisfying(["1.0.0-rc.10", "1.0.0-rc.2", "1.0.0-rc.1"], ">=1.0.0-rc.2") == "1.0.0-rc.2"


def test_invalid_input_raises():
    for bad in ["abc", ">=1.2.a", "1.2.3.4", "=>1.0.0", "~1.2.3.4", "1.2.3 -"]:
        with pytest.raises(ValueError):
            satisfies("1.2.3", bad)
    with pytest.raises(ValueError):
        max_satisfying([], "abc")
    with pytest.raises(ValueError):
        min_satisfying([], "abc")
    with pytest.raises(ValueError):
        satisfies("1.2", ">=1.0.0")
    with pytest.raises(ValueError):
        intersects("abc", "*")
    with pytest.raises(ValueError):
        intersects("*", "1.2.3.4")


def test_intersects_boundaries():
    meet(">=1.0.0 <1.0.0", "*", False)
    meet(">=1.0.0 <1.0.0", ">=1.0.0 <1.0.0", False)
    meet("<=1.0.0", ">=1.0.0", True)
    meet("<1.0.0", ">=1.0.0", False)
    meet(">1.0.0", "<1.0.1", False)
    meet(">1.0.0", "<=1.0.1", True)
    meet("1.2.3", "1.2.3", True)
    meet("1.2.3", "1.2.4", False)
    meet("*", "", True)


def test_intersects_caret_tilde_and_x_ranges():
    meet("^0.0.3", "~0.0.3", True)
    meet("^0.0.3", ">=0.0.4", False)
    meet("^0.2.3", "0.3.x", False)
    meet("^0.2.3", "0.2.x", True)
    meet("^1.2.3", "~1.9", True)
    meet("^1.2.3", "<1.2.3", False)
    meet("1.x", "<1.0.0", False)
    meet("1.x", ">=1.9.9", True)
    meet("1.2", "~1.2.5", True)
    meet("1.2.x", ">1.2", False)
    meet("<=1.2", ">1.2.9", True)
    meet("<1.2", ">=1.2", False)


def test_intersects_or_sets():
    meet("<1.0.0 || >=3.0.0", "2.x || 3.1.x", True)
    meet("<1.0.0 || >=3.0.0", "1.x || 2.x", False)
    meet("1.2.7 || 1.2.9", ">1.2.7 <1.2.9", False)
    meet("1.2.7 || 1.2.9", ">1.2.7 <=1.2.9", True)


def test_intersects_with_prereleases():
    meet(">=1.2.3-alpha.1 <1.2.3", "1.2.3-beta", True)
    meet(">=1.2.3-alpha.1 <1.2.3", "<1.2.3", False)
    meet(">=1.2.3-alpha.1 <1.2.3", ">=1.2.3-rc.1", True)
    meet(">=1.2.3-rc.1 <1.2.3", "1.2.3-beta", False)
    meet(">1.2.3-alpha.3", "<1.2.3-alpha.4", True)
    meet("<1.2.3-alpha.3", ">1.2.2", False)
    meet("<1.2.3-alpha.3", ">=1.2.0", True)
    meet(">1.2.3-alpha.3", "<1.2.4", True)
    meet("1.2.3-alpha.1", "*", False)
    meet("^1.2.3-beta.2", "~1.2.3-beta.5", True)
    meet("^1.2.3-beta.2", "1.2.3-beta.1 || 1.2.4-beta.1", False)


def test_max_and_min_satisfying_scale():
    versions = big_versions()
    assert BIG_RANGE.count("||") == 49
    start = time.perf_counter()
    hi = max_satisfying(versions, BIG_RANGE)
    lo = min_satisfying(versions, BIG_RANGE)
    elapsed = time.perf_counter() - start
    assert hi == "994.4.7-rc.4"
    assert lo == "1.0.2-rc.1"
    assert elapsed < 2.0, f"max_satisfying + min_satisfying took {elapsed:.2f}s"


@pytest.mark.parametrize(
    "r2, expected",
    [(WIN_B, False), (WIN_B_LAST, True), (WIN_C, False)],
    ids=["touching-windows", "last-sets-overlap", "prereleases-excluded"],
)
def test_intersects_scale(r2, expected):
    start = time.perf_counter()
    got = intersects(WIN_A, r2)
    elapsed = time.perf_counter() - start
    assert got is expected
    assert elapsed < 1.0, f"intersects took {elapsed:.2f}s"
