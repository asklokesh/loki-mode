"""Shared pytest fixtures for Purple Lab backend tests."""
import sys
from pathlib import Path

import pytest

# Ensure the web-app directory is on the Python path so we can import server, auth, models
WEB_APP_DIR = Path(__file__).resolve().parent.parent
if str(WEB_APP_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_APP_DIR))


@pytest.fixture(autouse=True)
def _clear_docker_context_cache():
    """Clear the Docker context cache before each test to prevent stale data."""
    try:
        from server import _docker_context_cache
        _docker_context_cache.clear()
    except ImportError:
        pass
    yield
    try:
        from server import _docker_context_cache
        _docker_context_cache.clear()
    except ImportError:
        pass
