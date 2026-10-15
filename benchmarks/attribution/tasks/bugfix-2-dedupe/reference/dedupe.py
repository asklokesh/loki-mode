def dedupe(values, case_sensitive=True):
    seen = []
    out = []
    for v in values:
        key = v.casefold() if (not case_sensitive and isinstance(v, str)) else v
        if key in seen:
            continue
        seen.append(key)
        out.append(v)
    return out
