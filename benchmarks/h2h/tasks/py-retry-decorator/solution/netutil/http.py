import json
import time
from typing import Any, Callable

from .retry import retry


class TransientError(Exception):
    """A failure worth retrying (timeouts, 502/503)."""


def fetch_json(url: str, transport: Callable[[str], str], sleep: Callable[[float], None] = time.sleep) -> Any:
    """Fetches url through transport and parses the body as JSON.

    Retries TransientError up to 3 attempts in total, waiting 0.5s then 1s.
    """

    @retry(attempts=3, exceptions=(TransientError,), base_delay=0.5, factor=2.0, sleep=sleep)
    def once() -> Any:
        return json.loads(transport(url))

    return once()
