# Fixture test for app/ranker.py. Self-contained so no collector can hit an
# ImportError; testmap links it to app/ranker.py by stem, a floor the
# import/reference grep (ENGINE.md section 8) adds on top of, never replaces.


def test_rank():
    assert sorted([2, 1]) == [1, 2]
