"""Semantic Versioning 2.0.0 versions: parsing and precedence."""

import re
from functools import total_ordering

_IDENT = r"[0-9A-Za-z-]+"
_NUM = r"0|[1-9]\d*"
_VERSION_RE = re.compile(
    rf"^({_NUM})\.({_NUM})\.({_NUM})"
    rf"(?:-({_IDENT}(?:\.{_IDENT})*))?"
    rf"(?:\+({_IDENT}(?:\.{_IDENT})*))?$"
)


def _prerelease_key(ident):
    # Numeric identifiers sort numerically and before alphanumeric ones.
    return (0, int(ident), "") if ident.isdigit() else (1, 0, ident)


@total_ordering
class Version:
    """A parsed version. Build metadata is kept but ignored for precedence."""

    def __init__(self, major, minor, patch, prerelease=(), build=()):
        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = tuple(prerelease)
        self.build = tuple(build)

    @classmethod
    def parse(cls, text):
        if not isinstance(text, str):
            raise ValueError(f"invalid version: {text!r}")
        m = _VERSION_RE.match(text.strip())
        if not m:
            raise ValueError(f"invalid version: {text!r}")
        major, minor, patch, pre, build = m.groups()
        pre_parts = tuple(pre.split(".")) if pre else ()
        for ident in pre_parts:
            if ident.isdigit() and len(ident) > 1 and ident[0] == "0":
                raise ValueError(f"invalid version: {text!r}")
        return cls(int(major), int(minor), int(patch), pre_parts, tuple(build.split(".")) if build else ())

    @property
    def release(self):
        """(major, minor, patch) without prerelease or build."""
        return (self.major, self.minor, self.patch)

    def _key(self):
        if not self.prerelease:
            # A release sorts after every prerelease of the same major.minor.patch.
            return (self.release, 1, ())
        return (self.release, 0, tuple(_prerelease_key(p) for p in self.prerelease))

    def __eq__(self, other):
        if not isinstance(other, Version):
            return NotImplemented
        return self._key() == other._key()

    def __lt__(self, other):
        if not isinstance(other, Version):
            return NotImplemented
        return self._key() < other._key()

    def __hash__(self):
        return hash(self._key())

    def __str__(self):
        text = f"{self.major}.{self.minor}.{self.patch}"
        if self.prerelease:
            text += "-" + ".".join(self.prerelease)
        if self.build:
            text += "+" + ".".join(self.build)
        return text

    def __repr__(self):
        return f"Version({str(self)!r})"


def parse(text):
    return Version.parse(text)


def compare(a, b):
    """-1, 0 or 1 comparing two version strings or Version objects."""
    va = a if isinstance(a, Version) else Version.parse(a)
    vb = b if isinstance(b, Version) else Version.parse(b)
    return (va > vb) - (va < vb)
