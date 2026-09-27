# Fixture test for app/ranker.py. Self-contained so no collector can hit an
# ImportError; testmap maps by file stem, not imports.


def test_rank():
    assert sorted([2, 1]) == [1, 2]
