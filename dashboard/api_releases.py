"""Read-only "releases" view over git tags and the VERSION file.

WHY THIS EXISTS. Releases had zero API surface. Unlike the other read-only
domains this one has sources that DO exist in a plain checkout -- git tags
(780 in this repo) and VERSION -- so it needs no run to have happened first.

THE SOURCES, and what each can and cannot tell us:

  VERSION            the version the working tree currently claims. It is the
      value the next release WILL carry, so it is routinely AHEAD of the
      newest tag while unreleased work sits on the branch.
  git tags           the versions that actually shipped. Read with
      `git for-each-ref --sort=-v:refname refs/tags`, which orders by version
      NUMERICALLY. Not --sort=-creatordate: a hotfix cut from an old branch is
      newest by date while being an older version, and "newest tag" must mean
      the same thing as the side VERSION is compared against.

THE AHEAD CASE is the reason this domain is worth exposing. When VERSION is
ahead of every tag, NO tag is current, and every row reads is_current False.
The envelope therefore states `version`, `newest_tag` and `version_is_ahead`
directly, so a caller can tell "VERSION is ahead of the newest tag" apart from
"VERSION was unreadable" -- two states that produce identical rows.

Version comparison is NUMERIC, on an int tuple. A string compare puts "9.11.0"
BELOW "9.8.1" and would report this very repo as behind its own newest tag,
which is precisely backwards. Anything that does not parse to ints reads
version_is_ahead=None: unknown, never False.

THE HONESTY RULE, applied to what this domain actually measures. A tag with no
readable creation date reads date=None, never today's date. An unparseable
version reads version_is_ahead=None, never False. There is no cost or token
field here, so record_is_measured() from autonomy/lib/efficiency_cost.py --
the canonical predicate used by dashboard/api_runs.py -- has nothing to judge
and is deliberately not imported; importing it unused would only imply a
measurement this reader does not make.

CHANGELOG.md is deliberately NOT read. It parses cleanly (`## v9.11.0`
headings), but it carries no field of the row shape that git and VERSION do
not already supply, and `source` must list paths actually consulted rather
than paths considered.

Every returned envelope states `source` (the real paths read), `freshness_s`
(age in seconds of the newest file that actually contributed, None when
nothing did) and an explicit `reason` when empty -- the shape established by
dashboard/api_runs.py.
"""

from __future__ import annotations

import os
import subprocess
import time
from typing import Any, Optional

__all__ = ["list_releases", "UNKNOWN"]

# What an unmeasured value reads as. Same name and meaning as api_runs.UNKNOWN.
UNKNOWN = None

_VERSION_FILE = "VERSION"

# Real paths read, in the style of dashboard/api_runs.py._SOURCE_PATHS.
_SOURCE_PATHS = ("VERSION", "git tags (refs/tags)")

# One record per tag: "<tag>\x1f<iso date>". \x1f (unit separator) cannot occur
# in a git refname, so it cannot be produced by a tag name containing a pipe.
_TAG_FORMAT = "%(refname:short)\x1f%(creatordate:iso-strict)"

_GIT_TIMEOUT_S = 20


def _mtime(path: str) -> Optional[float]:
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _freshness(mtimes: list, now: Optional[float] = None) -> Optional[int]:
    """Age in seconds of the NEWEST file that contributed. None if none did.

    Copied in behaviour from api_runs._freshness, including the clamp at 0 so
    a file written during this call cannot report a negative age. Derived from
    file mtimes ONLY: a tag's creation date is the age of the RELEASE, not the
    age of this read, and using it would misreport freshness by years.
    """
    real = [m for m in mtimes if m is not None]
    if not real:
        return None
    return max(0, int((now if now is not None else time.time()) - max(real)))


def _read_version(repo_dir: str) -> Optional[str]:
    """The VERSION file's value, or None when absent/empty/unreadable."""
    try:
        with open(os.path.join(repo_dir, _VERSION_FILE), "r", encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def _version_tuple(value: Optional[str]) -> Optional[tuple]:
    """"v9.11.0" -> (9, 11, 0). None when it is not a numeric dotted version.

    None is the whole point: an unparseable version must make every comparison
    that depends on it read unknown rather than silently False. Pre-release
    suffixes ("9.1.0-rc1") do not parse to ints and so read unknown rather
    than being ordered by a rule this module never verified.
    """
    if not value:
        return None
    raw = value.strip().lstrip("vV")
    parts = raw.split(".")
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        return None


def _git_tags(repo_dir: str, limit: int) -> tuple:
    """([(tag, date|None)], reason|None), newest version first.

    --count applies AFTER the sort, so this stays cheap against a repo with
    hundreds of tags. A missing git binary and a non-repo directory are
    reported as distinct reasons, and both yield an empty list -- never a
    fabricated one.
    """
    cmd = [
        "git", "for-each-ref",
        "--sort=-v:refname",
        "--count=%d" % limit,
        "--format=" + _TAG_FORMAT,
        "refs/tags",
    ]
    try:
        proc = subprocess.run(
            cmd, cwd=repo_dir, capture_output=True, text=True,
            timeout=_GIT_TIMEOUT_S,
        )
    except FileNotFoundError:
        return [], "git executable not found on PATH"
    except subprocess.TimeoutExpired:
        return [], "git for-each-ref timed out after %ds" % _GIT_TIMEOUT_S
    except OSError as exc:
        return [], "git for-each-ref failed: %s" % (exc,)

    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        return [], "git for-each-ref failed in %s: %s" % (
            repo_dir, detail[0] if detail else "exit %d" % proc.returncode)

    out = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        tag, _sep, date = line.partition("\x1f")
        if not tag:
            continue
        # An empty date field reads None. creatordate is the tag's own date for
        # an annotated tag and the tagged commit's date for a lightweight one;
        # both are real measurements. Absent is absent -- never today.
        out.append((tag, date.strip() or UNKNOWN))
    return out, None


def list_releases(repo_dir: str, limit: int = 20, now: Optional[float] = None) -> dict:
    """Releases from git tags, newest version first.

    Returns an ENVELOPE, not a bare list, because the contract requires an
    explicit reason when the result is empty and a list cannot carry one:

        {"releases": [{"tag", "version", "date"|None, "is_current", "source"}],
         "version": str|None, "newest_tag": str|None,
         "version_is_ahead": bool|None,
         "source": [...], "freshness_s": int|None, "reason": None|str}

    version_is_ahead is True when the VERSION file names a version greater than
    every tag -- unreleased work on the branch, which is the normal state
    between releases. It is None (not False) whenever either side is missing or
    unparseable, because "we could not compare" is not "it is not ahead".

    is_current is a NUMERIC equality against VERSION, so exactly one tag can be
    current, and none is current while VERSION is ahead.
    """
    envelope = {
        "releases": [],
        "version": UNKNOWN,
        "newest_tag": UNKNOWN,
        "version_is_ahead": UNKNOWN,
        "source": list(_SOURCE_PATHS),
        "freshness_s": None,
        "reason": None,
    }
    if not repo_dir or not os.path.isdir(repo_dir):
        envelope["reason"] = "no repository directory at %s" % (repo_dir,)
        return envelope

    version = _read_version(repo_dir)
    envelope["version"] = version if version is not None else UNKNOWN
    envelope["freshness_s"] = _freshness(
        [_mtime(os.path.join(repo_dir, _VERSION_FILE))], now=now)

    if limit is not None and limit <= 0:
        envelope["reason"] = "limit must be positive, got %r" % (limit,)
        return envelope

    tags, reason = _git_tags(repo_dir, limit)
    if reason is not None:
        envelope["reason"] = reason
        return envelope
    if not tags:
        envelope["reason"] = "no tags under refs/tags in %s" % (repo_dir,)
        return envelope

    version_t = _version_tuple(version)
    envelope["newest_tag"] = tags[0][0]

    newest_t = _version_tuple(tags[0][0])
    if version_t is not None and newest_t is not None:
        envelope["version_is_ahead"] = version_t > newest_t
    else:
        # Left as None with a stated reason: one side did not parse, so the
        # comparison was not made. Reporting False here would assert a fact.
        envelope["reason"] = (
            "version_is_ahead unknown: %s did not parse as a numeric version"
            % ("VERSION (%r)" % (version,) if version_t is None
               else "newest tag (%r)" % (tags[0][0],))
        )

    for tag, date in tags:
        tag_t = _version_tuple(tag)
        envelope["releases"].append({
            "tag": tag,
            "version": tag.lstrip("vV") or tag,
            "date": date,
            # Numeric equality. A string compare would also make "v9.10.0" and
            # "9.1.0" behave unpredictably here, not just in the ahead check.
            "is_current": bool(tag_t is not None and version_t is not None
                               and tag_t == version_t),
            "source": "git tag %s" % tag,
        })
    return envelope
