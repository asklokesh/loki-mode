import functools
import time
from typing import Callable, Tuple, Type


def retry(
    attempts: int = 3,
    exceptions: Tuple[Type[BaseException], ...] = (Exception,),
    base_delay: float = 0.1,
    factor: float = 2.0,
    sleep: Callable[[float], None] = time.sleep,
):
    if attempts < 1:
        raise ValueError("attempts must be at least 1")

    def decorate(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            for n in range(1, attempts + 1):
                try:
                    return fn(*args, **kwargs)
                except exceptions:
                    if n == attempts:
                        raise
                    sleep(base_delay * factor ** (n - 1))

        return wrapper

    return decorate
