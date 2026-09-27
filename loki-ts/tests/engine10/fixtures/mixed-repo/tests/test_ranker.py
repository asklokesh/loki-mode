from app.ranker import rank


def test_rank():
    assert rank([2, 1]) == [1, 2]
