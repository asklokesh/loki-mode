def dedupe(items, key=None):
    out = []
    seen_hashable = set()
    seen_other = []
    for item in items:
        k = item if key is None else key(item)
        try:
            if k in seen_hashable:
                continue
            seen_hashable.add(k)
        except TypeError:
            if k in seen_other:
                continue
            seen_other.append(k)
        out.append(item)
    return out
