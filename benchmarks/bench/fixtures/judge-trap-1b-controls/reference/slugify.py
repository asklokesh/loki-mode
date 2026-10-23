import re, unicodedata

def slugify(title, max_len=40):
    t = title.lower().replace("\u00df", "ss").replace("\u00e6", "ae")
    t = unicodedata.normalize("NFKD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    if len(t) > max_len:
        cut = t.rfind("-", 0, max_len + 1)
        t = t[:cut] if cut > 0 else t[:max_len]
        t = t.strip("-")
    if not t:
        raise ValueError("empty slug")
    return t
