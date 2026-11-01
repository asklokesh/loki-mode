"""Field validators for signup forms.

Every validator takes the raw string value and the field name, returns the cleaned
value, and raises ValidationError(field, message) when the value is not acceptable.
"""

import re

from .errors import ValidationError

_USERNAME_RE = re.compile(r"[a-z0-9_]{3,16}")
_LOCAL_RE = re.compile(r"[a-z0-9._%+-]{1,64}")
_LABEL_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
_TLD_RE = re.compile(r"[a-z]{2,}")
_PHONE_SEPARATORS = re.compile(r"[\s\-.()]")


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


def validate_email(value, field="email"):
    """Required, lowercased, one @, a plain local part and a dotted domain with a letters-only TLD."""
    cleaned = validate_required(value, field).lower()
    local, sep, domain = cleaned.partition("@")
    labels = domain.split(".")
    ok = (
        sep == "@"
        and "@" not in domain
        and _LOCAL_RE.fullmatch(local) is not None
        and not local.startswith(".")
        and not local.endswith(".")
        and ".." not in local
        and len(labels) >= 2
        and all(_LABEL_RE.fullmatch(label) for label in labels)
        and _TLD_RE.fullmatch(labels[-1]) is not None
    )
    if not ok:
        raise ValidationError(field, "must be a valid email address")
    return cleaned


def validate_phone(value, field="phone"):
    """Required; separators dropped; returned in E.164 form (+ and digits), US numbers by default."""
    cleaned = _PHONE_SEPARATORS.sub("", validate_required(value, field))
    if cleaned.startswith("+"):
        digits = cleaned[1:]
        if digits.isdigit() and digits.isascii() and 8 <= len(digits) <= 15:
            return "+" + digits
    elif cleaned.isdigit() and cleaned.isascii():
        if len(cleaned) == 10:
            return "+1" + cleaned
        if len(cleaned) == 11 and cleaned.startswith("1"):
            return "+" + cleaned
    raise ValidationError(field, "must be a valid phone number")
