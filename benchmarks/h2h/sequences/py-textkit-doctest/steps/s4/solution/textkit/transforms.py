"""Text transforms used by the CMS."""
import re
import unicodedata

__all__ = ["slugify", "title_case", "truncate", "snake_case", "strip_accents", "word_wrap"]

_SMALL = {"a", "an", "and", "of", "the", "to", "in", "on", "or"}


def slugify(text):
    """Lowercase, keep a-z and 0-9, join the words with single hyphens.

    >>> slugify("  Hello, World!  ")
    'hello-world'
    """
    return "-".join(re.findall(r"[a-z0-9]+", text.lower()))


def title_case(text):
    """Capitalize each word except small words that are not first.

    >>> title_case("the lord of the rings")
    'The Lord of the Rings'
    """
    words = text.split()
    return " ".join(w.capitalize() if i == 0 or w.lower() not in _SMALL else w.lower() for i, w in enumerate(words))


def truncate(text, width, suffix="..."):
    """Cut text to width characters, suffix included.

    >>> truncate("Hello world", 8)
    'Hello...'
    """
    if width < len(suffix):
        raise ValueError("width must be at least the suffix length")
    if len(text) <= width:
        return text
    return text[: width - len(suffix)] + suffix


def snake_case(text):
    """Convert camelCase, PascalCase and separated words to snake_case.

    >>> snake_case("parseHTTPResponse")
    'parse_http_response'
    """
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", text)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)
    return "_".join(p for p in re.split(r"[\s\-_]+", s.lower()) if p)


def strip_accents(text):
    """Remove accents and other combining marks.

    >>> strip_accents("Crème Brûlée")
    'Creme Brulee'
    """
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def word_wrap(text, width):
    """Greedy word wrap into lines of at most width characters.

    >>> word_wrap("the quick brown fox", 10)
    ['the quick', 'brown fox']
    """
    if width < 1:
        raise ValueError("width must be positive")
    lines, cur = [], ""
    for w in text.split():
        if cur and len(cur) + 1 + len(w) <= width:
            cur += " " + w
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines
