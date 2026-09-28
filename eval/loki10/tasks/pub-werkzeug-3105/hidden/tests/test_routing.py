import pytest

from werkzeug import routing as r
from werkzeug.routing.exceptions import DuplicateRuleError


def test_no_duplicates() -> None:
    """A rule's subdomain part and websocket mode are considered for equality."""
    r.Map(
        [
            r.Rule("/", endpoint="index"),
            r.Rule("/", endpoint="websocket", websocket=True),
            r.Rule("/", endpoint="sub", subdomain="a"),
            r.Rule("/method", methods=["GET"]),
            r.Rule("/method", methods=["POST"]),
        ]
    )


def test_duplicate_method_overlap() -> None:
    """Rules with overlapping methods are duplicates."""
    with pytest.raises(DuplicateRuleError):
        r.Map(
            [
                r.Rule("/", methods=["GET", "POST"], endpoint="a"),
                r.Rule("/", methods=["POST", "PUT"], endpoint="b"),
            ]
        )


def test_no_duplicate_head_options() -> None:
    """Rules with overlapping HEAD and OPTIONS methods are not duplicates."""
    r.Map(
        [
            r.Rule("/", methods=["GET", "OPTIONS"], endpoint="a"),
            r.Rule("/", methods=["POST", "OPTIONS"], endpoint="b"),
        ]
    )


def test_duplicate_options_exact() -> None:
    """HEAD and OPTIONS methods are considered for duplicates as an exact match."""
    with pytest.raises(DuplicateRuleError):
        r.Map(
            [
                r.Rule("/", methods=["HEAD", "OPTIONS"], endpoint="a"),
                r.Rule("/", methods=["HEAD", "OPTIONS"], endpoint="b"),
            ]
        )
