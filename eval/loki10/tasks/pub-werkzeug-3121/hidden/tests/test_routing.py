import pytest

from werkzeug import routing as r
from werkzeug.exceptions import NotFound


def test_merge_slashes_match():
    url_map = r.Map(
        [
            r.Rule("/no/tail", endpoint="no_tail"),
            r.Rule("/yes/tail/", endpoint="yes_tail"),
            r.Rule("/with/<path:path>", endpoint="with_path"),
            r.Rule("/no//merge", endpoint="no_merge", merge_slashes=False),
            r.Rule("/no/merging", endpoint="no_merging", merge_slashes=False),
        ]
    )
    adapter = url_map.bind("localhost", "/")

    with pytest.raises(r.RequestRedirect) as excinfo:
        adapter.match("/no//tail")

    assert excinfo.value.new_url.endswith("/no/tail")

    with pytest.raises(r.RequestRedirect) as excinfo:
        adapter.match("/yes//tail")

    assert excinfo.value.new_url.endswith("/yes/tail/")

    with pytest.raises(r.RequestRedirect) as excinfo:
        adapter.match("/yes/tail//")

    assert excinfo.value.new_url.endswith("/yes/tail/")

    with pytest.raises(r.RequestRedirect):
        adapter.match("//yes///tail////")

    assert adapter.match("/no/tail")[0] == "no_tail"
    assert adapter.match("/yes/tail/")[0] == "yes_tail"

    _, rv = adapter.match("/with/http://example.com/")
    assert rv["path"] == "http://example.com/"
    _, rv = adapter.match("/with/x//y")
    assert rv["path"] == "x//y"

    assert adapter.match("/no//merge")[0] == "no_merge"

    assert adapter.match("/no/merging")[0] == "no_merging"
    pytest.raises(NotFound, lambda: adapter.match("/no//merging"))
