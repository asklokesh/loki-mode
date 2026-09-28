#!/usr/bin/env python3
"""Dependency inventory for loki-mode (D35 DEP-01, founder directive).

Discovers every manifest via `git ls-files` (never a filesystem walk), looks
up current vs latest-stable versions across npm, PyPI, GitHub Actions,
endoflife.date, the Terraform registry and the Homebrew tap, and writes a
grouped report to docs/v10/DEPS.md.

Stdlib only. Network lookups are cached to a JSON file under --cache so a
second run against the same cache directory produces a byte-identical
report: the header date is the date of the *first* run, read back from the
cache on every later run.

Inventory only: this script never edits a manifest, lockfile, workflow or
image. It only reads and reports.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
from datetime import date
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ImportError:  # pragma: no cover - fallback for older interpreters
    tomllib = None

USER_AGENT = "loki-dep-inventory/1.0 (+https://github.com/asklokesh/loki-mode)"
TIMEOUT = 12


# --------------------------------------------------------------------------
# git discovery
# --------------------------------------------------------------------------

def git_ls_files(repo_root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=repo_root, capture_output=True, text=True, check=True
    )
    return [line for line in out.stdout.splitlines() if line]


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------

class Cache:
    def __init__(self, path: Path):
        self.path = path
        if path.exists():
            self.data = json.loads(path.read_text())
        else:
            self.data = {"meta": {"first_run_date": date.today().isoformat()}}
            self._save()

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n")

    @property
    def run_date(self) -> str:
        return self.data["meta"]["first_run_date"]

    def get(self, bucket: str, key: str, fetcher):
        b = self.data.setdefault(bucket, {})
        if key in b:
            return b[key]
        try:
            value = fetcher()
            entry = {"ok": True, "value": value}
        except Exception as exc:  # noqa: BLE001 - report every failure reason
            entry = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:220]}
        b[key] = entry
        self._save()
        return entry


# --------------------------------------------------------------------------
# network fetchers (each raises on failure; Cache.get turns that into a
# recorded, unresolvable-with-reason entry instead of dropping the item)
# --------------------------------------------------------------------------

def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode())


def fetch_npm_latest(pkg: str) -> str:
    # Scoped packages (@scope/name) resolve fine against the registry with
    # the slash left unescaped, so no URL-quoting is needed here.
    data = _fetch_json(f"https://registry.npmjs.org/{pkg}")
    latest = data.get("dist-tags", {}).get("latest")
    if not latest:
        raise ValueError("no dist-tags.latest in registry response")
    return latest


def fetch_pypi_latest(pkg: str) -> str:
    data = _fetch_json(f"https://pypi.org/pypi/{pkg}/json")
    version = data.get("info", {}).get("version")
    if not version:
        raise ValueError("no info.version in PyPI response")
    return version


def _gh_api(path: str, jq: str) -> str:
    proc = subprocess.run(
        ["gh", "api", path, "--jq", jq], capture_output=True, text=True, timeout=20
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[:200] or f"gh api {path} failed")
    result = proc.stdout.strip()
    if not result:
        raise ValueError(f"empty result from gh api {path}")
    return result


def fetch_gh_release_latest(owner_repo: str) -> str:
    try:
        return _gh_api(f"repos/{owner_repo}/releases/latest", ".tag_name")
    except Exception:
        # Some actions repos tag without publishing a GitHub Release.
        return _gh_api(f"repos/{owner_repo}/tags", ".[0].name")


def fetch_endoflife(product: str) -> list:
    return _fetch_json(f"https://endoflife.date/api/{product}.json")


def fetch_bun_latest() -> str:
    return _gh_api("repos/oven-sh/bun/releases/latest", ".tag_name")


def fetch_terraform_provider_latest(source: str) -> str:
    # source looks like "hashicorp/aws"
    data = _fetch_json(f"https://registry.terraform.io/v1/providers/{source}")
    version = data.get("version")
    if not version:
        raise ValueError("no version field in Terraform registry response")
    return version


def fetch_homebrew_formula() -> str:
    content_b64 = _gh_api(
        "repos/asklokesh/homebrew-tap/contents/Formula/loki-mode.rb", ".content"
    )
    return base64.b64decode(content_b64).decode()


# --------------------------------------------------------------------------
# version comparison
# --------------------------------------------------------------------------

def version_tuple(s: str):
    if not s:
        return None
    # Only the first constraint matters as a baseline: ">=0.40,<1.0.0" means
    # 0.40, not the 1.0.0 upper bound that a whole-string search would find.
    s = s.split(",")[0]
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", s)
    if m:
        return tuple(int(x) for x in m.groups())
    m = re.search(r"(\d+)\.(\d+)", s)
    if m:
        return (int(m.group(1)), int(m.group(2)), 0)
    m = re.search(r"(\d+)", s)
    if m:
        return (int(m.group(1)), 0, 0)
    return None


def bump_class(current: str, latest: str | None) -> str:
    if latest is None:
        return "unknown"
    cur = version_tuple(current)
    lat = version_tuple(latest)
    if cur is None or lat is None:
        return "unknown"
    if cur == lat:
        return "up-to-date"
    if cur[0] != lat[0]:
        return "MAJOR" if lat[0] > cur[0] else "ahead-of-latest"
    if cur[1] != lat[1]:
        return "minor" if lat[1] > cur[1] else "ahead-of-latest"
    return "patch" if lat[2] > cur[2] else "ahead-of-latest"


# --------------------------------------------------------------------------
# Row model
# --------------------------------------------------------------------------

class Row:
    __slots__ = ("file", "name", "current", "latest", "bump", "note", "fixture")

    def __init__(self, file, name, current, latest, bump, note="", fixture=False):
        self.file = file
        self.name = name
        self.current = current
        self.latest = latest
        self.bump = bump
        self.note = note
        self.fixture = fixture


def is_fixture(path: str) -> bool:
    return "/fixtures/" in path or "/tests/" in path or path.startswith("tests/")


def fill_missing_files(rows: list[Row], all_files: list[str], note: str) -> list[Row]:
    """Every discovered manifest must appear in the report even when it
    contributes zero rows, so a coverage check over `git ls-files` never
    finds a silently-dropped file."""
    covered = {r.file for r in rows}
    for f in all_files:
        if f not in covered:
            rows.append(Row(f, "(none found)", "", None, "n/a", note=note, fixture=is_fixture(f)))
    return rows


NO_BASELINE_NOTE = "no numeric version in spec (unpinned or a dist-tag like 'latest'); cannot compute a bump class"


def npm_row(cache: Cache, file: str, name: str, spec: str) -> Row:
    entry = cache.get("npm", name, lambda: fetch_npm_latest(name))
    if entry["ok"]:
        latest = entry["value"]
        bump = bump_class(spec, latest)
        note = NO_BASELINE_NOTE if bump == "unknown" else ""
        return Row(file, name, spec, latest, bump, note=note, fixture=is_fixture(file))
    return Row(file, name, spec, None, "unknown", note=entry["error"], fixture=is_fixture(file))


def pypi_row(cache: Cache, file: str, name: str, spec: str) -> Row:
    entry = cache.get("pypi", name, lambda: fetch_pypi_latest(name))
    if entry["ok"]:
        latest = entry["value"]
        bump = bump_class(spec, latest)
        note = NO_BASELINE_NOTE if bump == "unknown" else ""
        return Row(file, name, spec, latest, bump, note=note, fixture=is_fixture(file))
    return Row(file, name, spec, None, "unknown", note=entry["error"], fixture=is_fixture(file))


# --------------------------------------------------------------------------
# npm/bun manifests
# --------------------------------------------------------------------------

def collect_npm(repo_root: Path, files: list[str], cache: Cache) -> list[Row]:
    rows: list[Row] = []
    for f in files:
        try:
            data = json.loads((repo_root / f).read_text())
        except Exception as exc:  # noqa: BLE001
            rows.append(Row(f, "(parse error)", "", None, "unknown", note=str(exc)))
            continue
        for section in ("dependencies", "devDependencies"):
            for name, spec in sorted(data.get(section, {}).items()):
                rows.append(npm_row(cache, f, name, spec))
    return fill_missing_files(rows, files, "no dependencies or devDependencies declared")


# --------------------------------------------------------------------------
# python manifests
# --------------------------------------------------------------------------

REQ_LINE_RE = re.compile(r"^([A-Za-z0-9_.\-]+)\s*(\[[^\]]*\])?\s*(.*)$")


def parse_requirements(text: str) -> list[tuple[str, str]]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-r "):
            continue  # cross-file reference, not a package pin
        line = line.split(" #", 1)[0].strip()
        m = REQ_LINE_RE.match(line)
        if not m:
            continue
        name, _extras, spec = m.groups()
        out.append((name, spec.strip() or "(unpinned)"))
    return out


def collect_requirements(repo_root: Path, files: list[str], cache: Cache) -> list[Row]:
    rows: list[Row] = []
    for f in files:
        text = (repo_root / f).read_text()
        for name, spec in parse_requirements(text):
            rows.append(pypi_row(cache, f, name, spec))
    return fill_missing_files(rows, files, "no package lines found (only comments and/or -r references)")


def parse_pyproject_deps(text: str, path: Path) -> list[tuple[str, str]]:
    deps: list[str] = []
    if tomllib is not None:
        try:
            data = tomllib.loads(text)
        except Exception:
            data = None
        if data is not None:
            deps.extend(data.get("project", {}).get("dependencies", []))
            for group_deps in data.get("project", {}).get("optional-dependencies", {}).values():
                deps.extend(group_deps)
            deps.extend(data.get("build-system", {}).get("requires", []))
    else:  # pragma: no cover - regex fallback, stdlib-only, no PEP 517 backend
        m = re.search(r"dependencies\s*=\s*\[(.*?)\]", text, re.S)
        if m:
            deps.extend(re.findall(r'"([^"]+)"', m.group(1)))
    out = []
    for d in deps:
        m = REQ_LINE_RE.match(d.strip())
        if m:
            name, _extras, spec = m.groups()
            out.append((name, spec.strip() or "(unpinned)"))
    return out


def collect_pyproject(repo_root: Path, files: list[str], cache: Cache) -> list[Row]:
    rows: list[Row] = []
    for f in files:
        text = (repo_root / f).read_text()
        deps = parse_pyproject_deps(text, repo_root / f)
        if not deps:
            rows.append(Row(f, "(none declared)", "", None, "n/a", fixture=is_fixture(f)))
            continue
        for name, spec in deps:
            rows.append(pypi_row(cache, f, name, spec))
    return rows


# --------------------------------------------------------------------------
# GitHub Actions
# --------------------------------------------------------------------------

USES_RE = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(#\s*(.*))?$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def parse_workflow_uses(text: str) -> list[tuple[str, str]]:
    out = []
    for line in text.splitlines():
        m = USES_RE.match(line)
        if not m:
            continue
        target, _, comment = m.groups()
        out.append((target, (comment or "").strip()))
    return out


def collect_actions(repo_root: Path, files: list[str], cache: Cache) -> list[Row]:
    rows: list[Row] = []
    seen_in_file = set()
    for f in files:
        text = (repo_root / f).read_text()
        for target, comment in parse_workflow_uses(text):
            m = re.match(r"^([^/]+)/([^/@]+)(/[^@]*)?@(.+)$", target)
            if not m:
                continue
            owner, repo, _subpath, ref = m.groups()
            owner_repo = f"{owner}/{repo}"
            key = (f, target)
            if key in seen_in_file:
                continue
            seen_in_file.add(key)
            pinned_sha = bool(SHA_RE.match(ref))
            display_current = f"{ref}" + (f"  # {comment}" if comment else "")
            entry = cache.get("gh_release", owner_repo, lambda owner_repo=owner_repo: fetch_gh_release_latest(owner_repo))
            if entry["ok"]:
                latest = entry["value"]
                if pinned_sha:
                    if comment:
                        bump = bump_class(comment, latest)
                        note = "SHA-pinned"
                    else:
                        # A bare SHA carries no version number; comparing it
                        # numerically against a release tag is meaningless.
                        bump = "unknown"
                        note = f"SHA-pinned, no version comment; latest release is {latest}"
                else:
                    bump = bump_class(ref, latest)
                    note = "tag-pinned (not SHA-pinned)"
                    if re.match(r"^v?\d+$", ref) and bump in ("minor", "patch"):
                        # A bare-major tag ("v4") already floats onto the
                        # newest release within that major; the "behind"
                        # reading here is minor/patch drift within v-major,
                        # not a version this repo has to bump by hand.
                        note += "; floating major tag already tracks the latest release within that major"
            else:
                latest = None
                bump = "unknown"
                note = entry["error"]
            rows.append(Row(f, target, display_current, latest, bump, note=note, fixture=is_fixture(f)))
    return fill_missing_files(rows, files, "no `uses:` step found in this workflow/action file")


# --------------------------------------------------------------------------
# runtime matrices
# --------------------------------------------------------------------------

RUNTIME_ARRAY_RE = re.compile(r"(node-version|python-version|bun-version)\s*:\s*\[([^\]]*)\]")
RUNTIME_SCALAR_RE = re.compile(r"(node-version|python-version|bun-version)\s*:\s*\"?([A-Za-z0-9_.\-]+)\"?\s*$")
ARRAY_ITEM_RE = re.compile(r'"([^"]+)"|\'([^\']+)\'|([A-Za-z0-9_.\-]+)')


def collect_runtimes(repo_root: Path, workflow_files: list[str]) -> dict[str, dict[str, set[str]]]:
    """Return {key: {version: {files that pin it}}}."""
    found: dict[str, dict[str, set[str]]] = {"node-version": {}, "python-version": {}, "bun-version": {}}
    for f in workflow_files:
        text = (repo_root / f).read_text()
        for line in text.splitlines():
            m = RUNTIME_ARRAY_RE.search(line)
            if m:
                key, body = m.groups()
                for item_m in ARRAY_ITEM_RE.finditer(body):
                    val = next(g for g in item_m.groups() if g)
                    found[key].setdefault(val, set()).add(f)
                continue
            m = RUNTIME_SCALAR_RE.search(line)
            if m:
                key, val = m.groups()
                if "${{" in val:
                    continue  # matrix interpolation, not a literal version
                found[key].setdefault(val, set()).add(f)
    return found


def format_files(files: set[str], cap: int = 5) -> str:
    ordered = sorted(files)
    if len(ordered) <= cap:
        return ", ".join(ordered)
    return ", ".join(ordered[:cap]) + f", +{len(ordered) - cap} more"


def eol_label(eol_field, run_date_str: str) -> tuple[str, bool]:
    if eol_field is False:
        return "supported, no EOL date published", False
    if eol_field is True:
        return "EOL (no date given)", True
    try:
        run_d = date.fromisoformat(run_date_str)
        eol_d = date.fromisoformat(str(eol_field))
        past = eol_d <= run_d
        return (f"EOL {eol_field} (past)" if past else f"EOL {eol_field} (not yet)"), past
    except Exception:  # noqa: BLE001 - an unparsable date is not a crash
        return f"EOL {eol_field}", False


def eol_lookup(cache: Cache, run_date: str, product: str, cycle: str) -> dict:
    """Resolve one endoflife.date cycle. Returns ok, label, past, the
    latest patch in that cycle, and the newest cycle overall (for computing
    a bump class against "current stable", not just this cycle's patches)."""
    entry = cache.get("endoflife", product, lambda: fetch_endoflife(product))
    if not entry["ok"]:
        return {"ok": False, "error": entry["error"]}
    cycles = entry["value"]
    if not cycles:
        return {"ok": False, "error": "empty endoflife.date response"}
    newest = cycles[0]
    row = next((c for c in cycles if str(c.get("cycle")) == cycle), None)
    resolved_note = ""
    if row is None:
        # A floating major-only tag (docker `redis:7`) has no exact cycle;
        # fall back to the newest cycle that starts with "7.".
        candidates = [c for c in cycles if str(c.get("cycle")).startswith(cycle + ".")]
        if not candidates:
            return {"ok": False, "error": "unknown cycle (not in endoflife.date data)"}
        row = candidates[0]
        resolved_note = f"resolved floating tag '{cycle}' to cycle {row.get('cycle')}"
    label, past = eol_label(row.get("eol"), run_date)
    return {
        "ok": True,
        "label": label,
        "past": past,
        "cycle": row.get("cycle"),
        "latest_in_cycle": row.get("latest"),
        "newest_cycle": newest.get("cycle"),
        "newest_latest": newest.get("latest"),
        "resolved_note": resolved_note,
    }


def eol_bump(info: dict, current: str) -> str:
    if not info["ok"]:
        return "unknown"
    if info["past"]:
        return "EOL"
    return bump_class(current, info["newest_latest"] or info["newest_cycle"])


def build_runtime_rows(cache: Cache, runtimes: dict[str, dict[str, set[str]]]) -> list[Row]:
    rows: list[Row] = []
    for key, label, product in (
        ("node-version", "Node.js", "nodejs"),
        ("python-version", "Python", "python"),
        ("bun-version", "Bun", None),
    ):
        for version, files in sorted(runtimes[key].items()):
            files_col = format_files(files)
            if not re.match(r"^\d", version):
                rows.append(Row(files_col, label, version, None, "unknown", note="not a numeric version, skipped"))
                continue
            if product:
                info = eol_lookup(cache, cache.run_date, product, version)
                if info["ok"]:
                    note = info["label"]
                    if info["resolved_note"]:
                        note += f"; {info['resolved_note']}"
                    rows.append(Row(files_col, label, version, info["latest_in_cycle"],
                                     eol_bump(info, version), note=note))
                else:
                    rows.append(Row(files_col, label, version, None, "unknown", note=info["error"]))
            else:
                bun_entry = cache.get("bun_release", "latest", fetch_bun_latest)
                if bun_entry["ok"]:
                    latest = bun_entry["value"]
                    rows.append(Row(files_col, label, version, latest, bump_class(version, latest)))
                else:
                    rows.append(Row(files_col, label, version, None, "unknown", note=bun_entry["error"]))
    return rows


# --------------------------------------------------------------------------
# Docker / compose
# --------------------------------------------------------------------------

FROM_RE = re.compile(r"^FROM\s+(\S+)", re.I)
IMAGE_RE = re.compile(r"^\s*image:\s*[\"']?([^\"'\s]+)[\"']?\s*$")

# Base-image name -> endoflife.date product, and how to read a cycle out of
# the tag. Covers every FROM/image seen in this repo's Dockerfiles and
# compose files; anything else (own product images, :latest floating tags,
# third-party images with no endoflife.date product) is left unmapped.
DEBIAN_CODENAME_TO_CYCLE = {"bookworm": "12", "bullseye": "11", "trixie": "13", "buster": "10", "stretch": "9"}
DOCKER_IMAGE_PRODUCTS = {
    "node": ("nodejs", r"(\d+)"),
    "python": ("python", r"(\d+\.\d+)"),
    "nginx": ("nginx", r"(\d+\.\d+)"),
    "postgres": ("postgresql", r"(\d+)"),
    "redis": ("redis", r"(\d+(?:\.\d+)?)"),
    "ubuntu": ("ubuntu", r"(\d+\.\d+)"),
}


def docker_image_product_cycle(image: str):
    name, _, tag = image.rpartition(":")
    if not name:
        name, tag = image, "latest"
    name = name.rsplit("/", 1)[-1]
    if tag in ("latest", ""):
        return None
    if name in DOCKER_IMAGE_PRODUCTS:
        product, pattern = DOCKER_IMAGE_PRODUCTS[name]
        m = re.match(pattern, tag)
        return (product, m.group(1)) if m else None
    if name == "debian":
        for codename, cycle in DEBIAN_CODENAME_TO_CYCLE.items():
            if tag.startswith(codename):
                return ("debian", cycle)
    return None


def docker_row(cache: Cache, file: str, image: str) -> Row:
    mapping = docker_image_product_cycle(image)
    if mapping is None:
        return Row(file, image, image, None, "unknown",
                   note="floating tag or no endoflife.date product mapped for this image (own product image, or an unmapped base)")
    product, cycle = mapping
    info = eol_lookup(cache, cache.run_date, product, cycle)
    if not info["ok"]:
        return Row(file, image, image, None, "unknown", note=info["error"])
    note = info["label"]
    if info["resolved_note"]:
        note += f"; {info['resolved_note']}"
    return Row(file, image, image, info["latest_in_cycle"], eol_bump(info, cycle), note=note)


def collect_docker(repo_root: Path, dockerfiles: list[str], compose_files: list[str], cache: Cache) -> list[Row]:
    rows: list[Row] = []
    for f in dockerfiles:
        text = (repo_root / f).read_text()
        for line in text.splitlines():
            m = FROM_RE.match(line.strip())
            if m:
                rows.append(docker_row(cache, f, m.group(1)))
    for f in compose_files:
        text = (repo_root / f).read_text()
        for line in text.splitlines():
            m = IMAGE_RE.match(line)
            if m:
                rows.append(docker_row(cache, f, m.group(1)))
    return fill_missing_files(rows, dockerfiles + compose_files, "no `FROM` / `image:` line found (build-context-only service, or a multi-stage FROM this pass did not match)")


# --------------------------------------------------------------------------
# Helm
# --------------------------------------------------------------------------

def collect_helm(repo_root: Path, helm_files: list[str]) -> list[Row]:
    rows: list[Row] = []
    chart_yaml = next((f for f in helm_files if f.endswith("Chart.yaml")), None)
    if chart_yaml:
        text = (repo_root / chart_yaml).read_text()
        m = re.search(r'^appVersion:\s*"?([^"\n]+)"?', text, re.M)
        app_version = m.group(1).strip() if m else "(none)"
        rows.append(Row(chart_yaml, "appVersion", app_version, None, "n/a", note="tracks the loki-mode product VERSION, not an external dep"))
        if "dependencies:" not in text:
            rows.append(Row(chart_yaml, "chart dependencies", "(none declared)", None, "n/a"))
    for f in helm_files:
        if not f.endswith((".yaml", ".yml")) or f.endswith("Chart.yaml"):
            continue
        text = (repo_root / f).read_text()
        for line in text.splitlines():
            m = IMAGE_RE.match(line)
            if m:
                image = m.group(1)
                rows.append(Row(f, image, image, None, "unknown",
                                 note="floating/arbitrary registry tag, see Docker section for endoflife-mapped images"))
        rep = re.search(r"^\s*repository:\s*(\S+)", text, re.M)
        tag = re.search(r"^\s*tag:\s*\"?([^\"\n]*)\"?", text, re.M)
        if rep:
            repo_name = rep.group(1)
            tag_val = tag.group(1) if tag else ""
            display = f"{repo_name}:{tag_val or '(defaults to appVersion)'}"
            rows.append(Row(f, "image.repository", display, None, "n/a", note="own product image, tracked via VERSION not a third-party dep"))
    return fill_missing_files(rows, helm_files, "no image reference or chart metadata found (a template, RBAC, or other non-image manifest)")


# --------------------------------------------------------------------------
# Terraform
# --------------------------------------------------------------------------

PROVIDER_BLOCK_RE = re.compile(
    r'required_providers\s*\{(.*?)\n\s*\}', re.S
)
PROVIDER_ENTRY_RE = re.compile(
    r'(\w+)\s*=\s*\{\s*source\s*=\s*"([^"]+)"\s*version\s*=\s*"([^"]+)"', re.S
)


def collect_terraform(repo_root: Path, tf_files: list[str], cache: Cache) -> list[Row]:
    rows: list[Row] = []
    for f in tf_files:
        text = (repo_root / f).read_text()
        block_m = PROVIDER_BLOCK_RE.search(text)
        if not block_m:
            continue
        for name, source, spec in PROVIDER_ENTRY_RE.findall(block_m.group(1)):
            entry = cache.get("terraform", source, lambda source=source: fetch_terraform_provider_latest(source))
            if entry["ok"]:
                latest = entry["value"]
                rows.append(Row(f, f"{name} ({source})", spec, latest, bump_class(spec, latest)))
            else:
                rows.append(Row(f, f"{name} ({source})", spec, None, "unknown", note=entry["error"]))
    return fill_missing_files(rows, tf_files, "no `required_providers` block in this file (module wiring, not a version pin)")


# --------------------------------------------------------------------------
# Homebrew
# --------------------------------------------------------------------------

def collect_homebrew(cache: Cache, repo_version: str | None) -> list[Row]:
    loc = "asklokesh/homebrew-tap:Formula/loki-mode.rb"
    version_note = f"repo VERSION file is {repo_version}" if repo_version else "no repo VERSION file found"
    entry = cache.get("homebrew", "loki-mode.rb", fetch_homebrew_formula)
    if not entry["ok"]:
        return [Row(loc, "loki-mode", "(unresolved)", None, "unknown", note=f"{entry['error']}; {version_note}")]
    formula = entry["value"]
    # loki-mode's formula has no literal `version "..."` line; the version
    # is embedded in the release download URL (releases/download/vX.Y.Z/...).
    m = re.search(r'version\s+"([^"]+)"', formula)
    if not m:
        m = re.search(r"releases/download/v([0-9][0-9A-Za-z.\-]*)/", formula)
    pinned = m.group(1) if m else None
    npm_entry = cache.get("npm", "loki-mode", lambda: fetch_npm_latest("loki-mode"))
    latest = npm_entry["value"] if npm_entry["ok"] else None
    note = version_note if npm_entry["ok"] else f"{npm_entry['error']}; {version_note}"
    if pinned is None:
        return [Row(loc, "loki-mode", "(version not found in formula)", latest, "unknown", note=version_note)]
    return [Row(loc, "loki-mode", pinned, latest, bump_class(pinned, latest), note=note)]


# --------------------------------------------------------------------------
# report rendering
# --------------------------------------------------------------------------

def render_table(rows: list[Row]) -> str:
    lines = ["| File | Name | Current | Latest stable | Bump | Note |",
             "|---|---|---|---|---|---|"]
    for r in rows:
        current = (r.current or "").replace("|", "\\|")
        latest = (r.latest or "-").replace("|", "\\|") if r.latest else "-"
        note = r.note.replace("|", "\\|").replace("\n", " ") if r.note else ""
        if r.fixture and "test fixture" not in note:
            note = ("test fixture; " + note) if note else "test fixture, not a real dependency"
        lines.append(f"| `{r.file}` | `{r.name}` | `{current}` | `{latest}` | {r.bump} | {note} |")
    return "\n".join(lines)


def summarize(rows: list[Row]) -> dict[str, int]:
    counts = {"patch": 0, "minor": 0, "MAJOR": 0, "EOL": 0, "unknown": 0, "up-to-date": 0, "other": 0}
    for r in rows:
        if r.fixture:
            continue
        if r.bump in counts:
            counts[r.bump] += 1
        else:
            counts["other"] += 1
    return counts


def build_report(cache: Cache, repo_root: Path, groups: dict) -> str:
    out = []
    out.append("# Dependency Inventory (D35 DEP-01)\n")
    out.append(f"Generated by `scripts/dep-inventory.py`. Lookup date: {cache.run_date}.\n")
    out.append(
        "Inventory only. No dependency, lockfile, workflow or image was changed to produce "
        "this report. Manifests are discovered with `git ls-files`, never a filesystem walk. "
        "Network lookups are cached under the `--cache` directory so re-running against the "
        "same cache is byte-identical.\n"
    )

    all_rows: dict[str, list[Row]] = {}

    out.append("## npm / bun\n")
    npm_rows = groups["npm"]
    all_rows["npm"] = npm_rows
    out.append(render_table(npm_rows) + "\n")

    out.append("## Python (requirements*.txt)\n")
    req_rows = groups["requirements"]
    all_rows["python-requirements"] = req_rows
    out.append(render_table(req_rows) + "\n")

    out.append("## Python (pyproject.toml)\n")
    pyproject_rows = groups["pyproject"]
    all_rows["python-pyproject"] = pyproject_rows
    out.append(render_table(pyproject_rows) + "\n")

    out.append("## GitHub Actions (`uses:`)\n")
    action_rows = groups["actions"]
    all_rows["actions"] = action_rows
    out.append(render_table(action_rows) + "\n")

    node20_files = groups["runtimes"]["node-version"].get("20", set())
    if node20_files:
        out.append(
            "**Node 20 runtime deprecation:** GitHub-hosted `actions/checkout@v4` and "
            "`actions/setup-node@v4` themselves run fine on any runner, but upstream has "
            "named Node 20 runtime deprecation warnings in CI logs for actions still "
            f"targeting `node-version: 20`. Files pinning Node 20: {format_files(node20_files, cap=99)}.\n"
        )

    out.append("## Runtime matrices\n")
    runtime_rows = groups["runtime_rows"]
    all_rows["runtimes"] = runtime_rows
    header_bits = []
    for label, product in (("Node.js", "nodejs"), ("Python", "python")):
        entry = cache.get("endoflife", product, lambda product=product: fetch_endoflife(product))
        if entry["ok"] and entry["value"]:
            newest = entry["value"][0]
            header_bits.append(f"{label} current stable: {newest.get('latest')} (cycle {newest.get('cycle')})")
    bun_entry = cache.get("bun_release", "latest", fetch_bun_latest)
    if bun_entry["ok"]:
        header_bits.append(f"Bun current stable: {bun_entry['value']}")
    if header_bits:
        out.append("; ".join(header_bits) + ".\n")
    out.append("(The File column lists every workflow file pinning that version.)\n")
    out.append(render_table(runtime_rows) + "\n")

    out.append("## Docker / Compose images\n")
    docker_rows = groups["docker"]
    all_rows["docker"] = docker_rows
    out.append(render_table(docker_rows) + "\n")

    out.append("## Helm (`deploy/helm/`)\n")
    helm_rows = groups["helm"]
    all_rows["helm"] = helm_rows
    out.append(render_table(helm_rows) + "\n")

    out.append("## Terraform providers\n")
    tf_rows = groups["terraform"]
    all_rows["terraform"] = tf_rows
    out.append(render_table(tf_rows) + "\n")

    out.append("## Homebrew\n")
    brew_rows = groups["homebrew"]
    all_rows["homebrew"] = brew_rows
    out.append(
        "Formula lives in a separate repo: `asklokesh/homebrew-tap`, "
        "`Formula/loki-mode.rb` (updated by `.github/workflows/release.yml` "
        "job `update-homebrew` via the GitHub Contents API on every release).\n"
    )
    out.append(render_table(brew_rows) + "\n")

    out.append("## Summary\n")
    out.append("| Ecosystem | patch | minor | MAJOR | EOL | unknown | up-to-date | other |")
    out.append("|---|---|---|---|---|---|---|---|")
    for label, key in (
        ("npm/bun", "npm"),
        ("Python (requirements)", "python-requirements"),
        ("Python (pyproject)", "python-pyproject"),
        ("GitHub Actions", "actions"),
        ("Runtimes", "runtimes"),
        ("Docker/Compose", "docker"),
        ("Helm", "helm"),
        ("Terraform", "terraform"),
        ("Homebrew", "homebrew"),
    ):
        c = summarize(all_rows[key])
        out.append(f"| {label} | {c['patch']} | {c['minor']} | {c['MAJOR']} | {c['EOL']} | {c['unknown']} | {c['up-to-date']} | {c['other']} |")
    out.append("")

    out.append("## Proposed slice list (D35)\n")
    out.append(build_slice_list(all_rows, groups["runtimes"], node20_files))

    return "\n".join(out) + "\n"


SDK_PACKAGE_NAMES = {"@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk"}


def _is_zero_x_breaking(row: Row) -> bool:
    """A 0.x -> 0.y caret bump is semver-breaking even though bump_class
    calls it "minor" (0.x has no stability guarantee across minors)."""
    if row.bump != "minor":
        return False
    cur = version_tuple(row.current)
    return cur is not None and cur[0] == 0


def dedupe_by_name(rows: list[Row]) -> dict[tuple, set]:
    """Group non-fixture MAJOR (or 0.x-breaking-minor) rows by (name, latest)
    -> the set of files that pin them, so one slice covers one package
    across every manifest that names it."""
    groups: dict[tuple, set] = {}
    for r in rows:
        if r.fixture or r.name in SDK_PACKAGE_NAMES:
            continue
        if r.bump != "MAJOR" and not _is_zero_x_breaking(r):
            continue
        groups.setdefault((r.name, r.latest, r.bump), set()).add(r.file)
    return groups


def dedupe_actions(action_rows: list[Row]):
    """Group Actions rows by owner/repo (stripping the @ref) so one bullet
    covers actions/checkout everywhere, not once per workflow file."""
    major: dict[tuple, dict] = {}
    tag_pinned: dict[str, set] = {}
    for r in action_rows:
        if r.fixture or r.name == "(none found)":
            continue
        owner_repo = r.name.split("@", 1)[0]
        if "tag-pinned" in (r.note or ""):
            tag_pinned.setdefault(owner_repo, set()).add(r.file)
        if r.bump == "MAJOR":
            key = (owner_repo, r.latest)
            g = major.setdefault(key, {"files": set(), "currents": set()})
            g["files"].add(r.file)
            g["currents"].add(r.current.split("  #")[0].strip())
    return major, tag_pinned


def build_slice_list(all_rows: dict[str, list[Row]], runtimes: dict, node20_files: set) -> str:
    lines: list[str] = []

    # LOW: patch+minor grouped PER ECOSYSTEM per D35 (one slice covers every
    # manifest file in that ecosystem; lockfiles regenerated and committed
    # in the slice). Excludes 0.x breaking minors, which are semver-major
    # in practice and route into the MEDIUM grouping below instead.
    for label, key in (("npm/bun", "npm"), ("Python", "python-requirements"), ("Python (pyproject)", "python-pyproject")):
        by_file: dict[str, list[str]] = {}
        for r in all_rows[key]:
            if r.fixture or r.bump not in ("patch", "minor") or _is_zero_x_breaking(r) or r.name in SDK_PACKAGE_NAMES:
                continue
            by_file.setdefault(r.file, []).append(f"{r.name} {r.current}->{r.latest}")
        if by_file:
            lines.append(f"- **LOW - {label} patch+minor batch** (one slice for the whole ecosystem, touching every file below; lockfiles regenerated and committed):")
            for f, pkgs in sorted(by_file.items()):
                lines.append(f"  - `{f}`: {', '.join(sorted(pkgs))}")

    # MEDIUM: one slice per unique MAJOR (or 0.x-breaking) package, deduped
    # across every manifest that names it.
    combined_major: dict[tuple, set] = {}
    for key in ("npm", "python-requirements", "python-pyproject"):
        for (name, latest, bump), files in dedupe_by_name(all_rows[key]).items():
            combined_major.setdefault((name, latest, bump), set()).update(files)
    if combined_major:
        lines.append("- **MEDIUM - one slice per MAJOR (or 0.x-breaking) package**, deduped across manifests:")
        for (name, latest, bump), files in sorted(combined_major.items()):
            tag = "0.x semver-breaking" if bump != "MAJOR" else "MAJOR"
            lines.append(f"  - `{name}` -> `{latest}` ({tag}): {format_files(files)}")

    # MEDIUM: Actions MAJOR, deduped by owner/repo across workflow files. Per
    # D35 these move to the latest major AND get SHA-pinned (with a "# vN"
    # comment) in the same slice, so they're excluded from the LOW
    # SHA-pinning batch below to avoid double-listing.
    action_major, tag_pinned = dedupe_actions(all_rows["actions"])
    if action_major:
        lines.append("- **MEDIUM - one slice per Actions MAJOR**, deduped by action across workflows (bump to latest major AND SHA-pin with a `# vN` comment in the same slice, per D35):")
        for (owner_repo, latest), info in sorted(action_major.items()):
            currents = ", ".join(sorted(info["currents"]))
            lines.append(f"  - `{owner_repo}` {currents} -> `{latest}`: {format_files(info['files'])}")

    # LOW: SHA-pin every tag-pinned action that is already on its latest
    # major (no version bump needed, just pin it), matching the existing
    # security-audit.yml pattern (SHA + trailing "# vN" comment).
    already_latest = {owner_repo: files for owner_repo, files in tag_pinned.items()
                       if owner_repo not in {k[0] for k in action_major}}
    if already_latest:
        lines.append(
            "- **LOW - Actions SHA-pinning** (already on latest major, just needs pinning): "
            "convert every tag-pinned `uses:` to a SHA pin with a trailing `# vN` comment "
            "(the pattern already used for `actions/checkout` and `actions/upload-artifact` "
            "in security-audit.yml):"
        )
        for owner_repo, files in sorted(already_latest.items()):
            lines.append(f"  - `{owner_repo}`: {format_files(files)}")

    # MEDIUM: Terraform providers, one slice each (they get individual
    # review, not a batch, per D35).
    tf_major = [r for r in all_rows["terraform"] if r.bump == "MAJOR"]
    if tf_major:
        lines.append("- **MEDIUM - one slice per Terraform provider MAJOR**:")
        for r in tf_major:
            lines.append(f"  - `{r.file}`: `{r.name}` {r.current} -> {r.latest}")

    # MEDIUM: runtime matrix, built from the actual EOL data.
    eol_runtimes = [r for r in all_rows["runtimes"] if r.bump == "EOL"]
    lines.append("- **MEDIUM - runtime matrix refresh**:")
    if eol_runtimes:
        for r in eol_runtimes:
            lines.append(f"  - `{r.name}` {r.current} is EOL ({r.note}), pinned by: {r.file}")
    if node20_files:
        lines.append(
            f"  - Node 20 is named in the upstream Actions runtime deprecation warnings even "
            f"where not yet past its endoflife.date EOL; pinned by: {format_files(node20_files, cap=99)}"
        )
    if not eol_runtimes and not node20_files:
        lines.append("  - nothing currently EOL; re-run this inventory periodically to catch drift.")

    # MEDIUM: SDKs, gated on the 5-task eval per D35, not the plain batch.
    sdk_lines = []
    for r in all_rows["npm"]:
        if r.name in SDK_PACKAGE_NAMES:
            sdk_lines.append(f"`{r.name}` {r.current} -> {r.latest} ({r.bump}, `{r.file}`)")
    lines.append(
        "- **MEDIUM - SDKs with the 5-task eval**: " + "; ".join(sorted(set(sdk_lines))) +
        ". Gated on the 5-task eval per D35, not the plain patch/minor batch."
    )

    # LOW/MEDIUM: Docker/Helm digest pass. Docker EOL rows are flagged
    # explicitly; Terraform is handled above, not lumped in here.
    docker_eol = [r for r in all_rows["docker"] if r.bump == "EOL"]
    lines.append(
        "- **LOW - Docker/Helm digest pass**: pin every `FROM` / `image:` tag by digest "
        "instead of a mutable tag (own-product images and `:latest` floating tags are out "
        "of scope for a version bump and tracked via VERSION instead)."
    )
    if docker_eol:
        for r in docker_eol:
            lines.append(f"  - EOL now: `{r.name}` in `{r.file}` ({r.note})")

    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", default=None, help="Cache directory (default: a temp dir)")
    parser.add_argument("--repo-root", default=None, help="Repo root (default: two dirs up from this script)")
    parser.add_argument("--output", default=None, help="Output path (default: docs/v10/DEPS.md under repo root)")
    args = parser.parse_args()

    repo_root = Path(args.repo_root) if args.repo_root else Path(__file__).resolve().parent.parent
    cache_dir = Path(args.cache) if args.cache else Path(tempfile.mkdtemp(prefix="loki-dep-inventory-"))
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = Cache(cache_dir / "dep-inventory-cache.json")

    output = Path(args.output) if args.output else repo_root / "docs" / "v10" / "DEPS.md"

    files = git_ls_files(repo_root)

    npm_files = [f for f in files if f.endswith("package.json")]
    req_files = [f for f in files if re.search(r"requirements.*\.txt$", f)]
    pyproject_files = [f for f in files if f.endswith("pyproject.toml")]
    workflow_files = [f for f in files if re.match(r"^\.github/workflows/.*\.ya?ml$", f)]
    action_files = [f for f in files if re.match(r"^\.github/actions/.*/action\.ya?ml$", f)]
    dockerfiles = [f for f in files if Path(f).name.startswith("Dockerfile")]
    compose_files = [f for f in files if re.match(r"docker-compose.*\.ya?ml$|compose\.ya?ml$", Path(f).name)]
    helm_files = [f for f in files if f.startswith("deploy/helm/") and f.endswith((".yaml", ".yml"))]
    tf_files = [f for f in files if f.endswith(".tf")]

    version_file = repo_root / "VERSION"
    repo_version = version_file.read_text().strip() if version_file.exists() else None

    runtimes = collect_runtimes(repo_root, workflow_files)
    groups = {
        "npm": collect_npm(repo_root, npm_files, cache),
        "requirements": collect_requirements(repo_root, req_files, cache),
        "pyproject": collect_pyproject(repo_root, pyproject_files, cache),
        "actions": collect_actions(repo_root, workflow_files + action_files, cache),
        "runtimes": runtimes,
        "runtime_rows": build_runtime_rows(cache, runtimes),
        "docker": collect_docker(repo_root, dockerfiles, compose_files, cache),
        "helm": collect_helm(repo_root, helm_files),
        "terraform": collect_terraform(repo_root, tf_files, cache),
        "homebrew": collect_homebrew(cache, repo_version),
    }

    report = build_report(cache, repo_root, groups)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(report)

    print(f"Wrote {output} ({len(report.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
