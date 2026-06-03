"""Shareable team-asset bundler for Loki Mode (R8).

Bundles a team's invested, reusable assets into a portable, REDACTED tarball
that can be re-imported into another project or a fresh clone. This is the
"individual setup -> org lock-in" mechanism: setup compounds into shared value.

Scope (what is and is NOT a duplicate):
  - `loki export` (autonomy/loki cmd_export) produces a SESSION SNAPSHOT
    (json/md/csv/timeline) of one .loki/ run. It is per-run, not portable
    across teams, and not redacted for sharing.
  - `loki assets` (this module) produces a PORTABLE, REDACTED team-asset
    tarball: cross-project + project memory/learnings, the agent registry,
    PRD templates, council config, and (optionally) the R5 wiki. Different
    scope, different artifact. It REUSES the proof_redact chokepoint rather
    than introducing a second redactor.

Redaction:
  - Single chokepoint: autonomy/lib/proof_redact.py. JSON/JSONL go through
    redact_tree(); Markdown/text go through redact_value(). set_context() is
    called first so absolute home/repo paths collapse to ~ / . before the
    bundle leaves the machine. No second redactor is defined here.

Asset map (source-of-truth -> bundle path -> restore root):
  - ~/.loki/learnings/*.jsonl       -> learnings/*.jsonl   -> $HOME/.loki/learnings
  - <project>/.loki/memory/**       -> memory/**           -> <project>/.loki/memory
  - <repo>/agents/types.json        -> agents/types.json   -> <repo>/agents
  - <repo>/templates/*.md           -> templates/*.md      -> <repo>/templates
  - <project>/.loki/council/*.json  -> council/*.json      -> <project>/.loki/council
  - <project>/.loki/wiki/*          -> wiki/*              -> <project>/.loki/wiki   (opt-in)

The export and import callers pass DIFFERENT repo_root values deliberately
(see autonomy/loki cmd_assets): export reads agents/templates from the loki
install ($SKILL_DIR, where team edits live and are read at runtime); import
writes them under the caller's cwd (the target clone root), never back into
the install. This module just honors the repo_root it is handed; the
asymmetry is enforced by the bash caller.

Honest limitations (stated, not hidden):
  - There is no separate per-user "custom agent" store today. "Custom agents"
    == the agents/types.json registry (41 shipped types plus any team edits).
    Bundling captures team edits/additions but also re-ships the defaults.
  - Likewise templates/ and agents/types.json are repo-shipped defaults; a
    bundle from a fresh checkout carries the stock set. That is expected: the
    value is captured team DELTAS travelling with the stock baseline.
  - agents/templates restore relative to the import caller's cwd. loki reads
    them from its install dir at runtime, so a global-install user must copy
    the restored agents/ + templates/ into their install. memory, learnings,
    council, and wiki restore to $HOME/.loki or <project>/.loki and take
    effect immediately.
"""

import io
import json
import os
import sys
import tarfile

# proof_redact lives next to this file (autonomy/lib/). Import it as the single
# redaction chokepoint -- do NOT reimplement any redaction here.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import proof_redact  # noqa: E402

SCHEMA_VERSION = "1.0"

# Asset categories included by default. "wiki" is opt-in (can be large / noisy).
DEFAULT_CATEGORIES = ["learnings", "memory", "agents", "templates", "council"]
OPTIONAL_CATEGORIES = ["wiki"]


def _redact_json_text(text):
    """Redact a JSON document string. Returns (redacted_text, count).

    Falls back to plain-string redaction when the text is not valid JSON.
    """
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        return proof_redact.redact_value(text), 0
    red, n = proof_redact.redact_tree(obj)
    return json.dumps(red, indent=2, ensure_ascii=False), n


def _redact_jsonl_text(text):
    """Redact a JSONL document line-by-line. Returns (redacted_text, count).

    Each non-blank line is parsed, redacted via redact_tree, reserialized.
    Lines that are not valid JSON are redacted as raw strings (best effort).
    """
    out_lines = []
    total = 0
    for line in text.splitlines():
        if not line.strip():
            out_lines.append(line)
            continue
        try:
            obj = json.loads(line)
            red, n = proof_redact.redact_tree(obj)
            out_lines.append(json.dumps(red, ensure_ascii=False))
            total += n
        except (ValueError, TypeError):
            out_lines.append(proof_redact.redact_value(line))
    return "\n".join(out_lines) + ("\n" if text.endswith("\n") else ""), total


def _redact_text(text):
    """Redact a Markdown / plain-text string. Returns (redacted_text, count).

    redact_value returns only the string, so we cannot get a per-call count
    here; we report 0 and rely on the aggregate manifest count from structured
    files. The redaction itself still happens.
    """
    return proof_redact.redact_value(text), 0


def _redact_for_path(rel_path, text):
    """Dispatch redaction by file extension. Returns (redacted_text, count)."""
    lower = rel_path.lower()
    if lower.endswith(".jsonl"):
        return _redact_jsonl_text(text)
    if lower.endswith(".json"):
        return _redact_json_text(text)
    # .md, .txt, and everything else: plain string redaction.
    return _redact_text(text)


def _iter_category_sources(category, home, repo_root, project_dir):
    """Yield (abs_source_path, bundle_rel_path) pairs for a category.

    bundle_rel_path is always relative to the bundle's category dir.
    """
    if category == "learnings":
        src_dir = os.path.join(home, ".loki", "learnings")
        if os.path.isdir(src_dir):
            for name in sorted(os.listdir(src_dir)):
                p = os.path.join(src_dir, name)
                if os.path.isfile(p):
                    yield p, os.path.join("learnings", name)
    elif category == "memory":
        src_dir = os.path.join(project_dir, ".loki", "memory")
        for abs_p, rel_p in _walk_files(src_dir, "memory"):
            yield abs_p, rel_p
    elif category == "agents":
        p = os.path.join(repo_root, "agents", "types.json")
        if os.path.isfile(p):
            yield p, os.path.join("agents", "types.json")
    elif category == "templates":
        src_dir = os.path.join(repo_root, "templates")
        if os.path.isdir(src_dir):
            for name in sorted(os.listdir(src_dir)):
                p = os.path.join(src_dir, name)
                if os.path.isfile(p) and name.endswith(".md"):
                    yield p, os.path.join("templates", name)
    elif category == "council":
        src_dir = os.path.join(project_dir, ".loki", "council")
        if os.path.isdir(src_dir):
            for name in sorted(os.listdir(src_dir)):
                p = os.path.join(src_dir, name)
                if os.path.isfile(p) and name.endswith(".json"):
                    yield p, os.path.join("council", name)
    elif category == "wiki":
        src_dir = os.path.join(project_dir, ".loki", "wiki")
        for abs_p, rel_p in _walk_files(src_dir, "wiki"):
            yield abs_p, rel_p


def _walk_files(src_dir, bundle_prefix):
    """Walk src_dir, yielding (abs_path, bundle_rel_path) for every file."""
    if not os.path.isdir(src_dir):
        return
    for root, _dirs, files in os.walk(src_dir):
        for name in sorted(files):
            abs_p = os.path.join(root, name)
            rel = os.path.relpath(abs_p, src_dir)
            yield abs_p, os.path.join(bundle_prefix, rel)


def export_bundle(out_path, home, repo_root, project_dir, categories):
    """Build a redacted tarball at out_path. Returns a manifest dict.

    All string content is redacted through proof_redact before it is written
    into the tarball; the original files on disk are never modified.
    """
    proof_redact.reset_context()
    proof_redact.set_context(home=home, repo_root=repo_root)

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "redaction_rules_version": proof_redact.RULES_VERSION,
        "categories": [],
        "files": [],
        "redactions": 0,
    }

    staged = []  # (bundle_rel_path, redacted_bytes)
    for category in categories:
        had_any = False
        for abs_src, bundle_rel in _iter_category_sources(
            category, home, repo_root, project_dir
        ):
            try:
                with open(abs_src, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except OSError:
                continue
            red_text, count = _redact_for_path(bundle_rel, text)
            staged.append((bundle_rel, red_text.encode("utf-8")))
            manifest["files"].append(bundle_rel)
            manifest["redactions"] += count
            had_any = True
        if had_any:
            manifest["categories"].append(category)

    # Write tarball: manifest.json first, then redacted assets.
    parent = os.path.dirname(os.path.abspath(out_path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)

    manifest_bytes = json.dumps(manifest, indent=2, ensure_ascii=False).encode(
        "utf-8"
    )
    with tarfile.open(out_path, "w:gz") as tar:
        _add_bytes(tar, "manifest.json", manifest_bytes)
        for bundle_rel, data in staged:
            _add_bytes(tar, os.path.join("assets", bundle_rel), data)

    return manifest


def _add_bytes(tar, arcname, data):
    """Add an in-memory bytes blob to a tarfile under arcname."""
    info = tarfile.TarInfo(name=arcname)
    info.size = len(data)
    info.mode = 0o644
    tar.addfile(info, io.BytesIO(data))


# Restore-root mapping for each bundle category. $HOME-scoped vs project-scoped
# is deliberate (see module docstring asset map).
def _restore_root(category, home, target_repo, target_project):
    if category == "learnings":
        return os.path.join(home, ".loki", "learnings")
    if category == "memory":
        return os.path.join(target_project, ".loki", "memory")
    if category == "agents":
        return os.path.join(target_repo, "agents")
    if category == "templates":
        return os.path.join(target_repo, "templates")
    if category == "council":
        return os.path.join(target_project, ".loki", "council")
    if category == "wiki":
        return os.path.join(target_project, ".loki", "wiki")
    return None


def _category_of(bundle_rel):
    """Top-level bundle dir == category name."""
    return bundle_rel.split("/", 1)[0]


def _safe_extract_member(member):
    """Reject path-traversal members (zip-slip / tar-slip)."""
    name = member.name
    if name.startswith("/") or ".." in name.split("/"):
        return False
    return True


def _merge_jsonl(existing_text, incoming_text):
    """Append-with-dedupe two JSONL bodies. Returns merged text.

    Dedupe key is the canonicalized line (json round-trip with sorted keys when
    parseable). Preserves existing order, then appends new unique lines.
    """
    def _norm_lines(text):
        norm = []
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                norm.append(
                    json.dumps(json.loads(line), sort_keys=True, ensure_ascii=False)
                )
            except (ValueError, TypeError):
                norm.append(line.strip())
        return norm

    existing = _norm_lines(existing_text)
    seen = set(existing)
    merged = list(existing)
    for line in _norm_lines(incoming_text):
        if line not in seen:
            seen.add(line)
            merged.append(line)
    return "\n".join(merged) + "\n" if merged else ""


def import_bundle(bundle_path, home, target_repo, target_project, merge=True):
    """Restore a bundle's assets to their mapped roots. Returns a result dict.

    merge=True: JSONL learnings are append-with-dedupe; all other files are
    overwritten. merge=False: every file is overwritten.
    """
    result = {"restored": [], "skipped": [], "merged": [], "schema_version": None}

    with tarfile.open(bundle_path, "r:gz") as tar:
        # Read manifest.
        try:
            mf = tar.extractfile("manifest.json")
            manifest = json.load(mf) if mf else {}
        except KeyError:
            manifest = {}
        result["schema_version"] = manifest.get("schema_version")

        for member in tar.getmembers():
            if not member.isfile():
                continue
            if not _safe_extract_member(member):
                result["skipped"].append(member.name)
                continue
            name = member.name
            if name == "manifest.json":
                continue
            if not name.startswith("assets/"):
                continue
            bundle_rel = name[len("assets/"):]
            category = _category_of(bundle_rel)
            root = _restore_root(category, home, target_repo, target_project)
            if root is None:
                result["skipped"].append(name)
                continue
            sub_rel = (
                bundle_rel.split("/", 1)[1] if "/" in bundle_rel else bundle_rel
            )
            # SECURITY: a malicious bundle can carry a member like
            # "assets/council//abs/path" whose sub_rel is absolute (or contains
            # ".."). os.path.join(root, abs) silently DISCARDS root, so validate
            # the FINAL resolved destination is inside the restore root --
            # member-name string checks alone are insufficient. Reject any escape;
            # this is an untrusted shared bundle (R8's threat model).
            root_real = os.path.realpath(root)
            dest_real = os.path.realpath(os.path.join(root, sub_rel))
            if dest_real != root_real and not dest_real.startswith(root_real + os.sep):
                result["skipped"].append(name)
                continue
            dest = dest_real
            os.makedirs(os.path.dirname(dest), exist_ok=True)

            fobj = tar.extractfile(member)
            if fobj is None:
                continue
            data = fobj.read().decode("utf-8", errors="replace")

            if merge and dest.lower().endswith(".jsonl") and os.path.isfile(dest):
                with open(dest, "r", encoding="utf-8", errors="replace") as f:
                    existing = f.read()
                merged = _merge_jsonl(existing, data)
                with open(dest, "w", encoding="utf-8") as f:
                    f.write(merged)
                result["merged"].append(dest)
            else:
                with open(dest, "w", encoding="utf-8") as f:
                    f.write(data)
                result["restored"].append(dest)

    return result


def inspect_bundle(bundle_path):
    """Return the manifest dict from a bundle without extracting assets."""
    with tarfile.open(bundle_path, "r:gz") as tar:
        try:
            mf = tar.extractfile("manifest.json")
            return json.load(mf) if mf else {}
        except KeyError:
            return {}


def _main(argv):
    """CLI shim used by autonomy/loki cmd_assets.

    Subcommands:
      export <out_path> [--categories a,b,c] [--wiki]
      import <bundle_path> [--no-merge]
      inspect <bundle_path>

    Roots are taken from the environment so the bash caller controls them:
      LOKI_ASSETS_HOME, LOKI_ASSETS_REPO, LOKI_ASSETS_PROJECT
    """
    if not argv:
        sys.stderr.write("usage: assets_bundle.py <export|import|inspect> ...\n")
        return 2

    sub = argv[0]
    rest = argv[1:]

    home = os.environ.get("LOKI_ASSETS_HOME", os.path.expanduser("~"))
    repo = os.environ.get("LOKI_ASSETS_REPO", os.getcwd())
    project = os.environ.get("LOKI_ASSETS_PROJECT", os.getcwd())

    if sub == "export":
        if not rest:
            sys.stderr.write("export: missing output path\n")
            return 2
        out_path = rest[0]
        categories = list(DEFAULT_CATEGORIES)
        i = 1
        while i < len(rest):
            if rest[i] == "--categories" and i + 1 < len(rest):
                categories = [
                    c.strip() for c in rest[i + 1].split(",") if c.strip()
                ]
                i += 2
                continue
            if rest[i] == "--wiki":
                if "wiki" not in categories:
                    categories.append("wiki")
                i += 1
                continue
            i += 1
        manifest = export_bundle(out_path, home, repo, project, categories)
        sys.stdout.write(json.dumps(manifest, indent=2) + "\n")
        return 0

    if sub == "import":
        if not rest:
            sys.stderr.write("import: missing bundle path\n")
            return 2
        bundle_path = rest[0]
        merge = "--no-merge" not in rest[1:]
        result = import_bundle(bundle_path, home, repo, project, merge=merge)
        sys.stdout.write(json.dumps(result, indent=2) + "\n")
        return 0

    if sub == "inspect":
        if not rest:
            sys.stderr.write("inspect: missing bundle path\n")
            return 2
        sys.stdout.write(json.dumps(inspect_bundle(rest[0]), indent=2) + "\n")
        return 0

    sys.stderr.write("unknown subcommand: " + sub + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
