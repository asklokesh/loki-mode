import pytest

from units import converters, registry


def test_values():
    assert converters.celsius_to_fahrenheit(37.5) == 99.5
    assert converters.celsius_to_fahrenheit(-40) == -40.0
    assert converters.celsius_to_fahrenheit(0) == 32
    assert converters.celsius_to_fahrenheit(21.111) == 70.0


@pytest.mark.parametrize("bad", ["1", None, True, [1]])
def test_rejects_non_numbers(bad):
    with pytest.raises(TypeError):
        converters.celsius_to_fahrenheit(bad)


def test_registered():
    assert registry.convert("celsius_to_fahrenheit", 100) == 212
    fn, src, dst = registry.CONVERTERS["celsius_to_fahrenheit"]
    assert fn is converters.celsius_to_fahrenheit and src and dst
