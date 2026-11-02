"""Text transforms used by the CMS."""
import re

__all__ = ["slugify", "title_case", "truncate"]

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
