import pytest

from units import converters, registry


def test_values():
    assert converters.kilometers_to_miles(10) == 6.214
    assert converters.kilometers_to_miles(0) == 0
    assert converters.kilometers_to_miles(1.609344) == 1.0


def test_negative():
    with pytest.raises(ValueError, match="distance must be non-negative"):
        converters.kilometers_to_miles(-1)


@pytest.mark.parametrize("bad", ["1", None, True])
def test_rejects_non_numbers(bad):
    with pytest.raises(TypeError):
        converters.kilometers_to_miles(bad)


def test_registered():
    assert registry.convert("kilometers_to_miles", 10) == 6.214
    fn, src, dst = registry.CONVERTERS["kilometers_to_miles"]
    assert fn is converters.kilometers_to_miles and src and dst
