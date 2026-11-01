from csvlite import parse_line, parse_text


def test_simple_fields():
    assert parse_line("a,b,c") == ["a", "b", "c"]


def test_unquoted_fields_are_trimmed():
    assert parse_line(" a , b ") == ["a", "b"]


def test_parse_text_maps_header():
    rows = parse_text("name,role\nann,admin\nbo,viewer\n")
    assert rows == [{"name": "ann", "role": "admin"}, {"name": "bo", "role": "viewer"}]
