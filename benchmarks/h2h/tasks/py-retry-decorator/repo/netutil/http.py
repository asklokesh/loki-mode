import json
import time
from typing import Any, Callable


class TransientError(Exception):
    """A failure worth retrying (timeouts, 502/503)."""


def fetch_json(url: str, transport: Callable[[str], str], sleep: Callable[[float], None] = time.sleep) -> Any:
    """Fetches url through transport and parses the body as JSON.

    Retries TransientError up to 3 attempts in total, waiting 0.5s then 1s.
    """
    last_exc = None
    for attempt in range(3):
        try:
            return json.loads(transport(url))
        except TransientError as exc:
            last_exc = exc
            if attempt < 2:
                sleep(0.5 * (2 ** attempt))
    raise last_exc
