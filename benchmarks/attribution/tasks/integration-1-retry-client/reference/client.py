import time

from service import ServiceUnavailable


def fetch_all(service, max_retries=3, sleep=time.sleep):
    items = []
    cursor = None
    while True:
        attempt = 0
        while True:
            try:
                page = service.get_page(cursor)
                break
            except ServiceUnavailable:
                if attempt >= max_retries:
                    raise
                sleep(0.1 * (2 ** attempt))
                attempt += 1
        items.extend(page["items"])
        cursor = page["next"]
        if cursor is None:
            return items
