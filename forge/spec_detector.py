"""Spec detector - reads a PRD/issue/checklist and emits ForgeRequirements.

The detector is intentionally simple in F-1: it reads the spec text and
applies keyword + section-heading heuristics to identify needed primitives.
F-2 will replace the heuristics with an LLM-graded extraction step, but the
deterministic baseline matters so the agent never gets a hallucinated
requirement.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from typing import List, Optional


# Schema version, bumped when ForgeRequirements layout changes.
SCHEMA = "loki.forge.requirements/v1"


@dataclass
class TableSpec:
    """A first-pass schema spec the agent will refine via forge_db_migrate."""

    name: str
    columns: List[str] = field(default_factory=list)
    rls: str = "own-row"  # one of: public, own-row, own-or-public, custom
    indices: List[str] = field(default_factory=list)


@dataclass
class ForgeRequirements:
    schema: str = SCHEMA
    none: bool = False
    tables: List[TableSpec] = field(default_factory=list)
    auth_providers: List[str] = field(default_factory=list)
    buckets: List[str] = field(default_factory=list)
    functions: List[str] = field(default_factory=list)
    schedules: List[str] = field(default_factory=list)
    realtime_channels: List[str] = field(default_factory=list)
    payments: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    def to_json(self) -> str:
        d = asdict(self)
        d["tables"] = [asdict(t) for t in self.tables]
        return json.dumps(d, indent=2, sort_keys=True)


# Keyword -> primitive mappings. Conservative: prefer false-negative over
# false-positive (we'd rather under-provision than hallucinate a table).

_AUTH_KEYWORDS = {
    "google": ["google sign", "google oauth", "sign in with google", "google login"],
    "github": ["github sign", "github oauth", "sign in with github"],
    "apple": ["apple sign", "sign in with apple"],
    "microsoft": ["microsoft sign", "azure ad", "entra id"],
    "email-password": ["email and password", "password login", "email/password",
                       "sign up with email"],
    "magic-link": ["magic link", "passwordless"],
    "webauthn": ["webauthn", "passkey", "passkeys"],
}

_BUCKET_KEYWORDS = [
    ("user-uploads", ["user upload", "user uploads", "users can upload",
                      "user-uploaded", "profile picture", "avatar"]),
    ("public-assets", ["public assets", "public-assets", "publicly accessible files",
                       "publicly readable"]),
    ("images", ["image upload", "photo upload", "user images", "user photos"]),
    ("attachments", ["attachment", "file attachment"]),
]

_PAYMENT_KEYWORDS = {
    "stripe": ["stripe", "subscriptions", "billing", "checkout"],
    "lemon-squeezy": ["lemon squeezy", "lemonsqueezy"],
    "paddle": ["paddle billing", "paddle.com"],
}

_REALTIME_KEYWORDS = [
    ("feed", ["realtime feed", "live feed", "live updates"]),
    ("chat", ["chat", "messaging", "direct messages", "live chat"]),
    ("presence", ["who is online", "presence", "online users"]),
    ("typing", ["typing indicator", "is typing"]),
]

_SCHEDULE_KEYWORDS = [
    ("daily-digest", ["daily digest", "daily summary", "morning email"]),
    ("weekly-report", ["weekly report", "weekly summary"]),
    ("cleanup", ["periodic cleanup", "scheduled cleanup", "cron"]),
]

# A simple noun-singularizer for table-name heuristics; we only need it to
# turn "users", "posts", "comments" etc. into stable identifiers. We do NOT
# try to be smart about English morphology - if the agent wants "octopi" we
# accept "octopuses" and move on.
_PLURALS = {
    "users": "user", "posts": "post", "comments": "comment",
    "messages": "message", "tasks": "task", "items": "item",
    "products": "product", "subscriptions": "subscription",
    "orders": "order", "payments": "payment", "events": "event",
    "tags": "tag", "categories": "category", "files": "file",
}


def _detect_tables(text: str) -> List[TableSpec]:
    """Pull plausible table names from explicit '... table' mentions and
    bullet/heading lists that look like data models. Conservative."""
    out: List[TableSpec] = []
    seen = set()

    # "users table", "posts table", "comments table"
    for m in re.finditer(r"\b([a-z][a-z0-9_]{2,30})\s+table\b", text, re.IGNORECASE):
        name = m.group(1).lower()
        if name in seen:
            continue
        seen.add(name)
        out.append(TableSpec(name=name, columns=["id pk", "created_at default now()"]))

    # markdown bullet "- users: id, email, created_at"
    for m in re.finditer(
        r"^\s*[-*]\s+([a-z][a-z0-9_]{2,30})\s*:\s*([^\n]+)$",
        text, re.MULTILINE | re.IGNORECASE,
    ):
        name = m.group(1).lower()
        cols = [c.strip() for c in m.group(2).split(",") if c.strip()]
        if name in seen or not cols:
            continue
        # Filter out non-table-like bullets (e.g. "users: 1000 active users").
        if not all(re.match(r"^[a-z_][a-z0-9_ \(\)>\.\-]*$", c, re.IGNORECASE)
                   for c in cols):
            continue
        seen.add(name)
        out.append(TableSpec(name=name, columns=cols))

    return out


def _detect_auth(text: str) -> List[str]:
    found = []
    low = text.lower()
    for provider, kws in _AUTH_KEYWORDS.items():
        if any(kw in low for kw in kws):
            found.append(provider)
    return found


def _detect_buckets(text: str) -> List[str]:
    found = []
    seen = set()
    low = text.lower()
    for bucket_name, kws in _BUCKET_KEYWORDS:
        if any(kw in low for kw in kws) and bucket_name not in seen:
            seen.add(bucket_name)
            found.append(bucket_name)
    return found


def _detect_payments(text: str) -> List[str]:
    found = []
    low = text.lower()
    for provider, kws in _PAYMENT_KEYWORDS.items():
        if any(kw in low for kw in kws):
            found.append(provider)
    return found


def _detect_realtime(text: str) -> List[str]:
    found = []
    seen = set()
    low = text.lower()
    for channel_name, kws in _REALTIME_KEYWORDS:
        if any(kw in low for kw in kws) and channel_name not in seen:
            seen.add(channel_name)
            found.append(channel_name)
    return found


def _detect_schedules(text: str) -> List[str]:
    found = []
    seen = set()
    low = text.lower()
    for sched_name, kws in _SCHEDULE_KEYWORDS:
        if any(kw in low for kw in kws) and sched_name not in seen:
            seen.add(sched_name)
            found.append(sched_name)
    return found


def detect_from_text(text: str) -> ForgeRequirements:
    """Run the deterministic detection over a spec string. Pure function;
    no I/O side effects."""
    if not text or not text.strip():
        return ForgeRequirements(none=True)

    tables = _detect_tables(text)
    auth_providers = _detect_auth(text)
    buckets = _detect_buckets(text)
    payments = _detect_payments(text)
    realtime = _detect_realtime(text)
    schedules = _detect_schedules(text)

    none = (not tables and not auth_providers and not buckets
            and not payments and not realtime and not schedules)
    return ForgeRequirements(
        none=none,
        tables=tables,
        auth_providers=auth_providers,
        buckets=buckets,
        payments=payments,
        realtime_channels=realtime,
        schedules=schedules,
        functions=[],
    )


def detect_from_path(spec_path: str) -> ForgeRequirements:
    """Read a spec file and run detection. Returns a 'none' record if the
    file is missing, empty, or unreadable - never raises so the RARV loop
    is not destabilized by a missing PRD."""
    if not spec_path or not os.path.isfile(spec_path):
        return ForgeRequirements(none=True,
                                 notes=[f"spec file not found: {spec_path}"])
    try:
        with open(spec_path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as e:
        return ForgeRequirements(none=True, notes=[f"read error: {e}"])
    return detect_from_text(text)


def detect_from_bmad_workspace(workspace_dir: str) -> ForgeRequirements:
    """X-37: detect from a BMAD planning workspace.

    Reads _bmad-output/planning-artifacts/prd-*.md and architecture.md
    if present, concatenates them, and runs the standard detector
    over the combined text. The detector heuristics work as-is because
    BMAD PRDs use the same prose patterns as freeform PRDs.

    Falls back gracefully when the workspace structure is absent.
    """
    if not isinstance(workspace_dir, str) or not os.path.isdir(workspace_dir):
        return ForgeRequirements(none=True,
                                 notes=[f"workspace not found: {workspace_dir}"])
    bmad_dir = os.path.join(workspace_dir, "_bmad-output", "planning-artifacts")
    if not os.path.isdir(bmad_dir):
        return ForgeRequirements(none=True,
                                 notes=["no _bmad-output/planning-artifacts/ found"])
    combined: List[str] = []
    for fname in sorted(os.listdir(bmad_dir)):
        if not (fname.endswith(".md") or fname.endswith(".markdown")):
            continue
        if not (fname.startswith("prd-") or fname.startswith("architecture")
                or fname.startswith("epics")):
            continue
        path = os.path.join(bmad_dir, fname)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                combined.append(f"<!-- {fname} -->\n" + f.read())
        except OSError:
            continue
    if not combined:
        return ForgeRequirements(none=True,
                                 notes=["bmad workspace has no detectable artifacts"])
    req = detect_from_text("\n\n".join(combined))
    req.notes.append(f"detected from BMAD workspace: {workspace_dir}")
    return req


def write_required_json(req: ForgeRequirements, forge_dir: str) -> str:
    """Persist ForgeRequirements to <forge_dir>/required.json. Returns the
    written path. Creates forge_dir if needed."""
    os.makedirs(forge_dir, exist_ok=True)
    path = os.path.join(forge_dir, "required.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write(req.to_json())
        f.write("\n")
    return path
