"""Hidden acceptance tests for spd-seq-dag (authored, D61 slice 17)."""


class TestDagBuild:
    def test_build(self):
        from more_itertools import spd_dag_build
        got = spd_dag_build.build("a -> c\na->b\n\nd\n")
        assert got == {"a": ["b", "c"], "b": [], "c": [], "d": []}

    def test_duplicate_edges(self):
        from more_itertools import spd_dag_build
        assert spd_dag_build.build("a->b\na->b") == {"a": ["b"], "b": []}

    def test_errors(self):
        from more_itertools import spd_dag_build
        import pytest
        for bad in ("a->", "->b", "a->b->c"):
            with pytest.raises(ValueError):
                spd_dag_build.build(bad)

class TestDagTopo:
    def test_order(self):
        from more_itertools import spd_dag_topo
        g = {"a": ["c"], "b": ["c"], "c": ["d"], "d": []}
        assert spd_dag_topo.topo_order(g) == ["a", "b", "c", "d"]

    def test_smallest_ready_first(self):
        from more_itertools import spd_dag_topo
        g = {"z": [], "m": ["z"], "a": []}
        assert spd_dag_topo.topo_order(g) == ["a", "m", "z"]

    def test_cycle_and_empty(self):
        from more_itertools import spd_dag_build, spd_dag_topo
        import pytest
        assert spd_dag_topo.topo_order({}) == []
        with pytest.raises(ValueError, match="cycle"):
            spd_dag_topo.topo_order(spd_dag_build.build("a->b\nb->a"))

class TestDagSched:
    def test_schedule(self):
        from more_itertools import spd_dag_sched
        g = {"a": ["c"], "b": ["c"], "c": []}
        assert spd_dag_sched.schedule(g, {"a": 3, "b": 5, "c": 1}) == {"a": 0, "b": 0, "c": 5}

    def test_default_duration(self):
        from more_itertools import spd_dag_sched
        g = {"a": ["b"], "b": ["c"], "c": []}
        assert spd_dag_sched.schedule(g, {}) == {"a": 0, "b": 1, "c": 2}

    def test_cycle_and_uses_topo(self):
        from more_itertools import spd_dag_sched, spd_dag_topo
        import pytest
        with pytest.raises(ValueError, match="cycle"):
            spd_dag_sched.schedule({"a": ["b"], "b": ["a"]}, {})
        orig = spd_dag_topo.topo_order

        def boom(g):
            raise ValueError("sentinel")

        spd_dag_topo.topo_order = boom
        try:
            with pytest.raises(ValueError, match="sentinel"):
                spd_dag_sched.schedule({"a": ["b"], "b": []}, {})
        finally:
            spd_dag_topo.topo_order = orig

class TestDagCrit:
    def test_path(self):
        from more_itertools import spd_dag_crit
        text = "a->c\nb->c\nc->d"
        assert spd_dag_crit.critical_path(text, {"a": 3, "b": 5, "c": 2, "d": 1}) == (8, ["b", "c", "d"])

    def test_ties_and_single(self):
        from more_itertools import spd_dag_crit
        assert spd_dag_crit.critical_path("a->c\nb->c", {}) == (2, ["a", "c"])
        assert spd_dag_crit.critical_path("x", {"x": 4}) == (4, ["x"])

    def test_empty_and_cycle(self):
        from more_itertools import spd_dag_crit
        import pytest
        assert spd_dag_crit.critical_path("", {}) == (0, [])
        with pytest.raises(ValueError, match="cycle"):
            spd_dag_crit.critical_path("a->b\nb->a", {})
