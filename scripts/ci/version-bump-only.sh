#!/usr/bin/env bash
# Is this push a version-bump-only commit whose parent's Tests run succeeded?
#
#   version-bump-only.sh check   exit 0 = eligible, 1 = not (needs EVENT_NAME, SHA)
#   version-bump-only.sh gate    prints exactly skip=true or skip=false on
#                                stdout and always exits 0 (needs EVENT_NAME,
#                                SHA, REPO, GH_TOKEN)
#
# test.yml's first job runs `gate` and skips its heavy jobs only on
# skip=true. That matters because a Tests run whose jobs are all skipped
# concludes success, and release.yml required-ci accepts success at the
# release SHA without looking at the parent. So skip=true needs BOTH:
#
#   1. eligibility no looser than release.yml required-ci STEP 1. The python
#      below is a byte-for-byte copy of that STEP's heredoc (dedented);
#      tests/test-version-bump-only.sh extracts STEP 1 from release.yml and
#      asserts the same verdict on every fixture diff. Change both together.
#   2. a completed push-event run named "Tests" with conclusion success at
#      the parent. Pending, failed, cancelled, absent, or an API error all
#      give skip=false: the full suite runs, it never waits.
#
# A chain of bump-only commits stays sound: each hop's diff is version-only
# and the version-bump consistency checks run on every push, skip or not.
set -uo pipefail

eligible() {
  PARENT=""
  [ "${EVENT_NAME:-}" = "push" ] || return 1
  PARENT="$(git rev-parse "${SHA}^" 2>/dev/null)" || return 1
  git cat-file -e "${PARENT}^{commit}" 2>/dev/null || return 1
  python3 - "$PARENT" "$SHA" <<'PYEOF'
import json, re, subprocess, sys

parent, sha = sys.argv[1], sys.argv[2]

# One per line, NO leading whitespace (see the job comment for what
# each path's own check additionally requires beyond being listed
# here: CHANGELOG.md is prepend-only; loki.js and loki.js.map each
# have their own debugId handling; everything else is a plain raw
# version-literal byte compare).
ALLOWLIST = {
    "VERSION", "package.json", "SKILL.md", "CHANGELOG.md", "CLAUDE.md",
    "Dockerfile", "Dockerfile.sandbox", "dashboard/__init__.py",
    "mcp/__init__.py", "server.json",
    "plugins/loki-mode/.claude-plugin/plugin.json",
    "loki-ts/dist/loki.js", "loki-ts/dist/loki.js.map",
    "docs/INSTALLATION.md", "wiki/Home.md", "wiki/_Sidebar.md",
    "wiki/API-Reference.md", "web-app/src/components/Footer.tsx",
    "web-app/src/components/WhatsNew.tsx",
}
REGULAR_MODES = {"100644", "100755"}
VERSION_RE = re.compile(rb"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
# Anchored at the true end of the byte string ONLY (no MULTILINE):
# this can match at most once, at the last line, so it can never be
# used to splice a hidden line in anywhere else in the file.
DEBUG_ID_TRAILER = re.compile(rb"(?:\r\n|\r|\n)?//# debugId=[0-9A-Fa-f-]+[ \t]*(?:\r\n|\r|\n)?\Z")
CHANGELOG_HEADING = re.compile(rb"(?m)^## v")

def fail(msg):
    print("normalizer: " + msg, file=sys.stderr)
    sys.exit(1)

def show_bytes(rev, path):
    r = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True)
    return r.stdout if r.returncode == 0 else None

# git diff --raw, NOT --name-only: every changed path must be a
# status-M, same-mode, regular-file change present on both sides.
# --no-renames turns a rename into a delete+add pair, which fails
# the "present on both sides as M" check by construction, so a
# rename INTO the allowlist (e.g. CHANGELOG.md -> wiki/Home.md)
# cannot slip through as if it were an ordinary edit.
raw = subprocess.run(["git", "diff", "--no-renames", "--raw", parent, sha],
                      capture_output=True)
if raw.returncode != 0:
    fail("git diff --raw failed")
lines = [l for l in raw.stdout.decode("utf-8", "replace").splitlines() if l]
if not lines:
    fail("empty diff")
line_re = re.compile(r'^:(\d+) (\d+) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*\t(.+)$')
changed = []
for line in lines:
    m = line_re.match(line)
    if not m:
        fail(f"unparseable raw diff line: {line!r}")
    old_mode, new_mode, status, path = m.groups()
    if path not in ALLOWLIST:
        fail(f"not on the allowlist: {path}")
    if status != "M":
        fail(f"not a modification (status {status}): {path}")
    if old_mode != new_mode or old_mode not in REGULAR_MODES:
        fail(f"not a same-mode regular file: {path} ({old_mode} -> {new_mode})")
    changed.append(path)

old_ver = show_bytes(parent, "VERSION")
new_ver = show_bytes(sha, "VERSION")
if old_ver is None or new_ver is None:
    fail("VERSION missing on one side")
old_ver, new_ver = old_ver.strip(), new_ver.strip()
if not VERSION_RE.match(old_ver) or not VERSION_RE.match(new_ver):
    fail("VERSION does not match ^\\d+\\.\\d+\\.\\d+$ on one side")

def version_only(old_b, new_b):
    # A NUL already present on either side would collide with the
    # substitution placeholder and falsely compare equal -- refuse
    # outright rather than risk that collision.
    if b"\x00" in old_b or b"\x00" in new_b:
        return False
    return old_b.replace(old_ver, b"\x00") == new_b.replace(new_ver, b"\x00")

for path in changed:
    old_b, new_b = show_bytes(parent, path), show_bytes(sha, path)
    if old_b is None or new_b is None:
        fail(f"could not read {path} on one side")

    if path == "CHANGELOG.md":
        # Insert-only: real entries are prepended AFTER a shared
        # header (title + Keep-a-Changelog blurb), not at byte 0, so
        # a plain "old is a suffix of new" check rejects every real
        # release. Instead: locate the parent's FIRST "## v" heading
        # (line-anchored) -- everything before it is the header,
        # everything from it onward is the old entries, and BOTH
        # must appear byte-for-byte unchanged in the new file, with
        # exactly one inserted block between them. That block must
        # itself open with "## v<NEW_VERSION>", and it is
        # immediately followed by the parent's old first heading
        # ("## v<OLD_VERSION>") by construction of the slice below.
        m = CHANGELOG_HEADING.search(old_b)
        if not m:
            fail("CHANGELOG.md has no '## v' heading to anchor the insert-only check")
        old_header, old_rest = old_b[:m.start()], old_b[m.start():]
        if not old_rest.startswith(b"## v" + old_ver):
            fail("CHANGELOG.md's first heading does not match VERSION")
        if not (new_b.startswith(old_header) and new_b.endswith(old_rest)
                and len(new_b) >= len(old_header) + len(old_rest)):
            fail("CHANGELOG.md is not insert-only (header or existing entries changed)")
        inserted = new_b[len(old_header):len(new_b) - len(old_rest)]
        if not inserted.startswith(b"## v" + new_ver):
            fail("CHANGELOG.md's inserted block does not open with the new version heading")
        continue

    if path == "loki-ts/dist/loki.js":
        old_b = DEBUG_ID_TRAILER.sub(b"", old_b, count=1)
        new_b = DEBUG_ID_TRAILER.sub(b"", new_b, count=1)
        if not version_only(old_b, new_b):
            fail("loki.js changed beyond the version string and its debugId trailer")
        continue

    if path == "loki-ts/dist/loki.js.map":
        try:
            old_j, new_j = json.loads(old_b), json.loads(new_b)
        except Exception as e:
            fail(f"loki.js.map is not valid JSON: {e}")
        if not isinstance(old_j, dict) or not isinstance(new_j, dict):
            fail("loki.js.map is not a JSON object")
        # E-157: the dropped debugId must be the same hex/dash shape as the
        # JS trailer, never free-form bytes the parent audit did not scan.
        for j in (old_j, new_j):
            d = j.pop("debugId", None)
            if d is not None and not (isinstance(d, str) and re.fullmatch(r"[0-9A-Fa-f-]+", d)):
                fail("loki.js.map debugId is not hex/dash shaped")
        old_canon = json.dumps(old_j, sort_keys=True, separators=(",", ":")).encode()
        new_canon = json.dumps(new_j, sort_keys=True, separators=(",", ":")).encode()
        if not version_only(old_canon, new_canon):
            fail("loki.js.map changed beyond the version string (top-level debugId excluded)")
        continue

    if not version_only(old_b, new_b):
        fail(f"{path} changed beyond the version string")

sys.exit(0)
PYEOF
}

parent_tests_green() {
  local n
  n="$(gh api "repos/$REPO/actions/runs?head_sha=$1&event=push&per_page=100" \
    --jq '[.workflow_runs[] | select(.event=="push" and .name=="Tests" and .status=="completed" and .conclusion=="success")] | length' 2>/dev/null)" || return 1
  case "$n" in '' | *[!0-9]*) return 1 ;; esac
  [ "$n" -gt 0 ]
}

case "${1:-}" in
  check)
    eligible
    ;;
  gate)
    if eligible && parent_tests_green "$PARENT"; then
      echo "version-bump-only: $SHA is bump-only and parent $PARENT has a green Tests run; heavy jobs skip" >&2
      echo "skip=true"
    else
      echo "version-bump-only: not eligible, or parent Tests not green; full suite runs" >&2
      echo "skip=false"
    fi
    exit 0
    ;;
  *)
    echo "usage: $0 check|gate" >&2
    exit 64
    ;;
esac
