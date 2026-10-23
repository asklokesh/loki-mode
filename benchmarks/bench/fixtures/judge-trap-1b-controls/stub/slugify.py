import re, unicodedata

def slugify(title, max_len=40):
    t = unicodedata.normalize("NFKD", title.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    t = t[:max_len].rstrip("-")
    if not t:
        raise ValueError("empty")
    return t
