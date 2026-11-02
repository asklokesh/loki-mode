import pytest

import textkit
from textkit import transforms


def test_values():
    assert transforms.word_wrap("the quick brown fox", 10) == ["the quick", "brown fox"]
    assert transforms.word_wrap("  ", 5) == []
    assert transforms.word_wrap("", 5) == []
    assert transforms.word_wrap("abcdefghijk xy", 5) == ["abcdefghijk", "xy"]
    assert transforms.word_wrap("a b c d", 3) == ["a b", "c d"]
    assert transforms.word_wrap("one\ttwo\n three", 7) == ["one two", "three"]


def test_bad_width():
    with pytest.raises(ValueError, match="width must be positive"):
        transforms.word_wrap("x", 0)


def test_conventions():
    assert "word_wrap" in transforms.__all__
    assert textkit.word_wrap is transforms.word_wrap
    assert ">>> " in (transforms.word_wrap.__doc__ or "")
