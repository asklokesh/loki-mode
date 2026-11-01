from csvlite import parse_line, parse_text


def test_quoted_comma_keeps_inner_spaces():
    assert parse_line('a,"b, c",d') == ["a", "b, c", "d"]


def test_doubled_quotes_are_literal():
    assert parse_line('"say ""hi"""') == ['say "hi"']
    assert parse_line('x,"a""b",y') == ["x", 'a"b', "y"]


def test_whitespace_inside_quotes_is_kept():
    assert parse_line('"  padded  ",z') == ["  padded  ", "z"]


def test_unquoted_still_trimmed():
    assert parse_line("  a ,b  ") == ["a", "b"]


def test_trailing_empty_field():
    assert parse_line("a,b,") == ["a", "b", ""]


def test_empty_middle_field():
    assert parse_line("a,,b") == ["a", "", "b"]


def test_empty_quoted_field():
    assert parse_line('a,"",b') == ["a", "", "b"]


def test_plain_fields_unchanged():
    assert parse_line("a,b,c") == ["a", "b", "c"]


def test_parse_text_uses_fixed_parser():
    rows = parse_text('name,motto\nann,"work, then rest"\nbo,"the ""best"""\n')
    assert rows == [
        {"name": "ann", "motto": "work, then rest"},
        {"name": "bo", "motto": 'the "best"'},
    ]
