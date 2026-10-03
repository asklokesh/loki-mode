"""Hidden acceptance tests for spd-seq-kv (authored, D61 slice 17)."""


class TestKvParse:
    def test_basic(self):
        from more_itertools import spd_kvparse
        assert spd_kvparse.parse_lines("a=1\n# c\n\n b = x=y \n") == [("a", "1"), ("b", "x=y")]

    def test_errors(self):
        from more_itertools import spd_kvparse
        import pytest
        for bad in ("novalue", "=v"):
            with pytest.raises(ValueError):
                spd_kvparse.parse_lines(bad)

    def test_empty(self):
        from more_itertools import spd_kvparse
        assert spd_kvparse.parse_lines("") == []

class TestKvSchema:
    def test_types(self):
        from more_itertools import spd_kvschema
        s = {"n": "int", "on": "bool", "name": "str"}
        got = spd_kvschema.validate([("n", "5"), ("on", "Yes"), ("name", "x")], s)
        assert got == {"n": 5, "on": True, "name": "x"}

    def test_override_and_bool_forms(self):
        from more_itertools import spd_kvschema
        s = {"n": "int", "b": "bool"}
        assert spd_kvschema.validate([("n", "1"), ("n", "2")], s) == {"n": 2}
        for t in ("true", "1", "YES"):
            assert spd_kvschema.validate([("b", t)], s)["b"] is True
        for f in ("false", "0", "no"):
            assert spd_kvschema.validate([("b", f)], s)["b"] is False

    def test_errors(self):
        from more_itertools import spd_kvschema
        import pytest
        with pytest.raises(KeyError):
            spd_kvschema.validate([("zz", "1")], {"n": "int"})
        with pytest.raises(ValueError):
            spd_kvschema.validate([("n", "x")], {"n": "int"})
        with pytest.raises(ValueError):
            spd_kvschema.validate([("b", "maybe")], {"b": "bool"})

class TestKvMerge:
    def test_layers(self):
        from more_itertools import spd_kvmerge
        s = {"n": "int", "on": "bool", "name": "str"}
        got = spd_kvmerge.merge(["n=1\nname=a", "n=2\non=yes", "# nothing"], s)
        assert got == {"n": 2, "name": "a", "on": True}

    def test_empty_and_propagation(self):
        from more_itertools import spd_kvmerge
        import pytest
        assert spd_kvmerge.merge([], {"n": "int"}) == {}
        with pytest.raises(KeyError):
            spd_kvmerge.merge(["zz=1"], {"n": "int"})
        with pytest.raises(ValueError):
            spd_kvmerge.merge(["n=abc"], {"n": "int"})

    def test_uses_earlier_stages(self):
        from more_itertools import spd_kvmerge, spd_kvparse
        orig = spd_kvparse.parse_lines
        spd_kvparse.parse_lines = lambda text: [("n", "99")]
        try:
            assert spd_kvmerge.merge(["ignored"], {"n": "int"}) == {"n": 99}
        finally:
            spd_kvparse.parse_lines = orig

class TestKvDump:
    def test_dump(self):
        from more_itertools import spd_kvdump
        s = {"n": "int", "on": "bool", "name": "str"}
        assert spd_kvdump.dump({"on": False, "n": 3, "name": "z"}, s) == "n=3\nname=z\non=false\n"
        assert spd_kvdump.dump({}, s) == ""

    def test_unknown(self):
        from more_itertools import spd_kvdump
        import pytest
        with pytest.raises(KeyError):
            spd_kvdump.dump({"q": 1}, {"n": "int"})

    def test_roundtrip(self):
        from more_itertools import spd_kvdump, spd_kvmerge
        s = {"n": "int", "on": "bool", "name": "str"}
        for c in ({"n": 0, "on": True, "name": "a b"}, {"name": "x=y"}, {}):
            assert spd_kvmerge.merge([spd_kvdump.dump(c, s)], s) == c
