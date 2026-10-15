import re
import unicodedata


def title_case(text):
    return " ".join(w[:1].upper() + w[1:].lower() for w in text.split())


def slugify(text, max_len=None):
    norm = unicodedata.normalize("NFKD", text)
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    slug = re.sub(r"[^a-z0-9]+", "-", norm.lower()).strip("-")
    if max_len is not None:
        slug = slug[:max_len].rstrip("-")
    return slug
