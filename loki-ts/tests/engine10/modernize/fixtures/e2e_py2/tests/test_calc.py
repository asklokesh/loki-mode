from legacy.calc import tally, label


def test_tally():
    assert tally({1: 1, 2: 2}) == 3


def test_label():
    assert label(u"ab") == "AB"
    assert label(7) == "7"
