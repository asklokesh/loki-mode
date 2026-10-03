"""Hidden acceptance tests for lg-par-seq (authored, D61 slice 17)."""


class TestChunk:
    def test_sizes(self):
        from more_itertools import lg_chunk
        assert lg_chunk.chunk_even(list(range(7)), 3) == [[0, 1, 2], [3, 4], [5, 6]]
        assert lg_chunk.chunk_even([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]

    def test_more_chunks_than_items(self):
        from more_itertools import lg_chunk
        assert lg_chunk.chunk_even([1, 2], 4) == [[1], [2], [], []]

    def test_error_and_str(self):
        from more_itertools import lg_chunk
        import pytest
        with pytest.raises(ValueError):
            lg_chunk.chunk_even([1], 0)
        assert lg_chunk.chunk_even("abcde", 2) == ["abc", "de"]

class TestWindow:
    def test_basic(self):
        from more_itertools import lg_window
        assert lg_window.sliding_sum([1, 2, 3, 4, 5], 2) == [3, 5, 7, 9]
        assert lg_window.sliding_sum([1, 2, 3], 3) == [6]

    def test_short(self):
        from more_itertools import lg_window
        assert lg_window.sliding_sum([1, 2], 3) == []
        assert lg_window.sliding_sum([], 1) == []

    def test_error_and_floats(self):
        from more_itertools import lg_window
        import pytest
        with pytest.raises(ValueError):
            lg_window.sliding_sum([1], 0)
        assert lg_window.sliding_sum([0.5, 0.25, 0.25], 2) == [0.75, 0.5]

class TestDedupe:
    def test_basic(self):
        from more_itertools import lg_dedupe
        assert lg_dedupe.dedupe_keep_last([1, 2, 1, 3, 2]) == [1, 3, 2]

    def test_key(self):
        from more_itertools import lg_dedupe
        got = lg_dedupe.dedupe_keep_last(["a1", "b1", "a2", "c1", "b2"], key=lambda s: s[0])
        assert got == ["a2", "c1", "b2"]

    def test_empty_and_unique(self):
        from more_itertools import lg_dedupe
        assert lg_dedupe.dedupe_keep_last([]) == []
        assert lg_dedupe.dedupe_keep_last("abc") == ["a", "b", "c"]

class TestRuns:
    def test_basic(self):
        from more_itertools import lg_runs
        assert lg_runs.longest_run([1, 1, 2, 2, 2, 3]) == (2, 3)

    def test_ties_earliest(self):
        from more_itertools import lg_runs
        assert lg_runs.longest_run("aabbcc") == ("a", 2)
        assert lg_runs.longest_run([5]) == (5, 1)

    def test_empty(self):
        from more_itertools import lg_runs
        import pytest
        with pytest.raises(ValueError):
            lg_runs.longest_run([])
