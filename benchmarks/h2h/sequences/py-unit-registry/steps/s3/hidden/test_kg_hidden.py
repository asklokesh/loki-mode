import pytest

from units import converters, registry


def test_values():
    assert converters.kilograms_to_pounds(70) == 154.32
    assert converters.kilograms_to_pounds(0) == 0
    assert converters.kilograms_to_pounds(1) == 2.2


def test_negative():
    with pytest.raises(ValueError, match="mass must be non-negative"):
        converters.kilograms_to_pounds(-0.5)


@pytest.mark.parametrize("bad", ["1", None, True])
def test_rejects_non_numbers(bad):
    with pytest.raises(TypeError):
        converters.kilograms_to_pounds(bad)


def test_registered():
    assert registry.convert("kilograms_to_pounds", 70) == 154.32
    fn, src, dst = registry.CONVERTERS["kilograms_to_pounds"]
    assert fn is converters.kilograms_to_pounds and src and dst
