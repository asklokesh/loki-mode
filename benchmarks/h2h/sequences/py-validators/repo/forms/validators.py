"""Field validators for signup forms.

Every validator takes the raw string value and the field name, returns the cleaned
value, and raises ValidationError(field, message) when the value is not acceptable.
"""

import re

from .errors import ValidationError

_USERNAME_RE = re.compile(r"[a-z0-9_]{3,16}")


def validate_required(value, field):
    """Strip surrounding whitespace; an empty result is an error."""
    cleaned = (value or "").strip()
    if not cleaned:
        raise ValidationError(field, "is required")
    return cleaned


def validate_username(value, field="username"):
    """Required, lowercased, 3 to 16 characters of a-z, 0-9 and _."""
    cleaned = validate_required(value, field).lower()
    if not _USERNAME_RE.fullmatch(cleaned):
        raise ValidationError(field, "must be 3 to 16 letters, digits or underscores")
    return cleaned
