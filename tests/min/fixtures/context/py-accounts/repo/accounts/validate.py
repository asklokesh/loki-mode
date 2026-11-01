"""Input validation."""
import re

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def looks_like_email(value):
    return bool(_EMAIL.match(value.strip()))


def clean_name(value):
    return " ".join(value.split())
