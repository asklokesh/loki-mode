import textkit
from textkit import transforms


def test_values():
    cases = {
        "HelloWorld": "hello_world",
        "parseHTTPResponse": "parse_http_response",
        "already_snake": "already_snake",
        " Some Words-here ": "some_words_here",
        "": "",
        "getID": "get_id",
        "XMLParser": "xml_parser",
        "a--b__c": "a_b_c",
    }
    for raw, want in cases.items():
        assert transforms.snake_case(raw) == want, raw


def test_conventions():
    assert "snake_case" in transforms.__all__
    assert textkit.snake_case is transforms.snake_case
    assert ">>> " in (transforms.snake_case.__doc__ or "")
