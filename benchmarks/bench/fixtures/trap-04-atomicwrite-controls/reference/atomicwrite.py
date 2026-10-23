import os
import tempfile


def write_atomic(path, chunks):
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory)
    total = 0
    try:
        with os.fdopen(fd, "wb") as fh:
            for chunk in chunks:
                fh.write(chunk)
                total += len(chunk)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    return total
