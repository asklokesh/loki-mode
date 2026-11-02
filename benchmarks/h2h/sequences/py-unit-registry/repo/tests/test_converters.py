import pytest

from units import converters, registry


def test_meters_to_feet():
    assert converters.meters_to_feet(1) == 3.281
    assert converters.meters_to_feet(0) == 0


def test_feet_to_meters():
    assert converters.feet_to_meters(10) == 3.048


def test_convert_by_name():
    assert registry.convert("feet_to_meters", 10) == 3.048
    assert registry.units("meters_to_feet") == ("m", "ft")
    with pytest.raises(KeyError):
        registry.convert("nope", 1)
