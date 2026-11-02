import pytest

from semverlite import Version, compare, parse


def test_parse_parts():
    v = parse("1.2.3-beta.1+build.5")
    assert v.release == (1, 2, 3)
    assert v.prerelease == ("beta", "1")
    assert v.build == ("build", "5")
    assert str(v) == "1.2.3-beta.1+build.5"


@pytest.mark.parametrize("bad", ["1.2", "1.2.3.4", "01.2.3", "1.2.3-", "a.b.c", "1.2.3-01", ""])
def test_parse_rejects_invalid(bad):
    with pytest.raises(ValueError):
        parse(bad)


def test_semver_spec_precedence_chain():
    chain = [
        "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
        "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0",
    ]
    for lo, hi in zip(chain, chain[1:]):
        assert compare(lo, hi) == -1
        assert compare(hi, lo) == 1


def test_build_metadata_is_ignored():
    assert compare("1.0.0+a", "1.0.0+b") == 0
    assert Version.parse("1.0.0+a") == Version.parse("1.0.0")


def test_sorting_versions():
    vs = sorted(parse(s) for s in ["2.0.0", "1.10.0", "1.2.0", "1.2.0-rc.1"])
    assert [str(v) for v in vs] == ["1.2.0-rc.1", "1.2.0", "1.10.0", "2.0.0"]
