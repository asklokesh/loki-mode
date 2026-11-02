import pytest

from units import converters, registry


def test_values():
    assert converters.liters_to_gallons(10) == 2.642
    assert converters.liters_to_gallons(3.785411784) == 1.0


def test_negative():
    with pytest.raises(ValueError, match="volume must be non-negative"):
        converters.liters_to_gallons(-2)


@pytest.mark.parametrize("bad", ["1", None, True])
def test_rejects_non_numbers(bad):
    with pytest.raises(TypeError):
        converters.liters_to_gallons(bad)


def test_registered():
    fn, src, dst = registry.CONVERTERS["liters_to_gallons"]
    assert fn is converters.liters_to_gallons and src and dst


def test_convert_all():
    assert registry.convert_all("liters_to_gallons", [10, 0]) == [2.642, 0]
    assert registry.convert_all("feet_to_meters", []) == []
    assert registry.convert_all("meters_to_feet", (1, 2)) == [3.281, 6.562]
    with pytest.raises(KeyError):
        registry.convert_all("nope", [1])
