def dedupe(items, key=None):
    seen = set()
    out = []
    for item in items:
        k = item if key is None else key(item)
        if k not in seen:
            seen.add(k)
            out.append(item)
    return out
