def write_atomic(path, chunks):
    total = 0
    with open(path, "wb") as fh:
        for chunk in chunks:
            fh.write(chunk)
            total += len(chunk)
    return total
