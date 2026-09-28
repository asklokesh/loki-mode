import pytest

from werkzeug import wrappers


def test_user_agent():
    user_agent = "Mozilla/5.0 (X11; Linux x86_64; rv:94.0) Gecko/20100101 Firefox/94.0"
    request = wrappers.Request({"HTTP_USER_AGENT": user_agent})
    assert request.user_agent == user_agent
    assert str(request.user_agent) == user_agent
    assert request.user_agent.lower() == user_agent.lower()

    with pytest.deprecated_call():
        assert request.user_agent.to_header() == user_agent

    with pytest.deprecated_call():
        assert request.user_agent.string == user_agent

    with pytest.deprecated_call():
        assert request.user_agent.browser is None
