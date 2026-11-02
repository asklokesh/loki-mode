from tomlkit import dumps
from tomlkit import loads


def test_write_backslash():
    d = {"foo": "\\e\u25E6\r"}

    expected = """foo = "\\\\e\u25E6\\r"
"""

    assert expected == dumps(d)
    assert loads(dumps(d))["foo"] == "\\e\u25E6\r"


def test_escape_special_characters_in_key():
    d = {"foo\nbar": "baz"}
    expected = '"foo\\nbar" = "baz"\n'
    assert expected == dumps(d)
    assert loads(dumps(d))["foo\nbar"] == "baz"


def test_write_inline_table_in_nested_arrays():
    d = {"foo": [[{"a": 1}]]}
    expected = "foo = [[{a = 1}]]\n"  # noqa: FS003
    assert expected == dumps(d)
    assert loads(dumps(d))["foo"] == [[{"a": 1}]]
