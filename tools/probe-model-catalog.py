#!/usr/bin/env python3
"""Probe provider documentation pages and report new models.

Approach kept deliberately conservative: we fetch known docs URLs, look for
model IDs that match well-defined regex patterns, and compare against the
current `providers/model_catalog.json`. We do NOT auto-rewrite the catalog;
we emit a report and a unified diff so a maintainer (or the cron-driven PR)
can review.

Run locally:
    python3 tools/probe-model-catalog.py            # report only
    python3 tools/probe-model-catalog.py --json     # machine-readable

In CI: see .github/workflows/model-catalog-probe.yml
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = REPO_ROOT / "providers" / "model_catalog.json"

# Patterns that look like provider model IDs. Conservative -- only the well
# defined Claude/Codex/Gemini families today.
PATTERNS: dict[str, list[re.Pattern[str]]] = {
    "claude": [
        re.compile(r"\bclaude-(?:opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?\b"),
    ],
    "codex": [
        re.compile(r"\bgpt-\d+(?:\.\d+)?-codex\b"),
    ],
    "gemini": [
        re.compile(r"\bgemini-\d+(?:\.\d+)?-(?:pro|flash)(?:-(?:preview|exp|latest))?\b"),
    ],
}

# Pages we read. These should be public documentation. Failure to fetch any
# single one is non-fatal -- we report what we got.
SOURCES: dict[str, list[str]] = {
    "claude": [
        "https://docs.claude.com/en/about-claude/models/overview",
    ],
    "codex": [
        "https://platform.openai.com/docs/models",
    ],
    "gemini": [
        "https://ai.google.dev/gemini-api/docs/models",
    ],
}

USER_AGENT = (
    "loki-mode-model-probe/1.0 "
    "(+https://github.com/asklokesh/loki-mode)"
)


def fetch(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="ignore")
    return body


def load_catalog() -> dict:
    with CATALOG_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def known_ids(catalog: dict, provider: str) -> set[str]:
    p = catalog.get("providers", {}).get(provider, {})
    ids: set[str] = set()
    for m in p.get("models", []):
        if isinstance(m, dict) and m.get("id"):
            ids.add(m["id"])
    for key in ("latest_planning", "latest_development", "latest_fast"):
        if p.get(key):
            ids.add(p[key])
    aliases = p.get("cli_aliases", {})
    if isinstance(aliases, dict):
        for v in aliases.values():
            if isinstance(v, str):
                ids.add(v)
    return ids


def probe_provider(provider: str) -> tuple[set[str], list[str]]:
    """Return (found_ids, errors)."""
    seen: set[str] = set()
    errors: list[str] = []
    for url in SOURCES.get(provider, []):
        try:
            body = fetch(url)
        except urllib.error.URLError as exc:
            errors.append(f"{url}: {exc}")
            continue
        except Exception as exc:  # network / parse / etc.
            errors.append(f"{url}: {type(exc).__name__}: {exc}")
            continue
        for pat in PATTERNS.get(provider, []):
            for m in pat.findall(body):
                seen.add(m)
    return seen, errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    ap.add_argument("--strict", action="store_true", help="exit nonzero if new models are found")
    args = ap.parse_args()

    catalog = load_catalog()
    report: dict[str, dict] = {}
    any_new = False
    for provider in PATTERNS:
        found, errors = probe_provider(provider)
        known = known_ids(catalog, provider)
        new_only = sorted(found - known)
        report[provider] = {
            "known_count": len(known),
            "found_count": len(found),
            "new_candidates": new_only,
            "errors": errors,
        }
        if new_only:
            any_new = True

    if args.json:
        json.dump(report, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        for provider, info in report.items():
            new = info["new_candidates"]
            errs = info["errors"]
            print(f"== {provider} ==")
            print(f"   known in catalog: {info['known_count']}")
            print(f"   found in docs:    {info['found_count']}")
            if new:
                print(f"   NEW CANDIDATES:   {', '.join(new)}")
            else:
                print(f"   NEW CANDIDATES:   (none)")
            for e in errs:
                print(f"   ERROR: {e}")
            print()
        if any_new:
            print("To adopt a new model: edit providers/model_catalog.json -> bump latest_<tier>")
            print("and add to models[]. Then re-run this script to confirm it disappears from new_candidates.")

    return 1 if (args.strict and any_new) else 0


if __name__ == "__main__":
    sys.exit(main())
