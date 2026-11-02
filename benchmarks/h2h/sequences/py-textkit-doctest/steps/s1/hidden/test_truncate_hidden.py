import pytest

import textkit
from textkit import transforms


def test_values():
    assert transforms.truncate("Hello world", 8) == "Hello..."
    assert transforms.truncate("Hello world", 8, suffix="~") == "Hello w~"
    assert transforms.truncate("Hi", 8) == "Hi"
    assert transforms.truncate("12345678", 8) == "12345678"
    assert transforms.truncate("123456789", 8) == "12345..."
    assert transforms.truncate("abcdef", 3) == "..."


def test_width_too_small():
    with pytest.raises(ValueError, match="width must be at least the suffix length"):
        transforms.truncate("abcdef", 2)


def test_conventions():
    assert "truncate" in transforms.__all__
    assert textkit.truncate is transforms.truncate
    assert ">>> " in (transforms.truncate.__doc__ or "")
