#!/usr/bin/env bash
# tests/test-gitleaks-incremental.sh - GITLEAKS-INCR
#
# A push to main scans only <previous release tag>..SHA; the full-history scan
# is the nightly backstop and gates promotion. The "Select gitleaks scan mode"
# step of security-audit.yml is extracted as written and run against scratch
# repos with a real origin. Every property is also checked against a mutated
# copy that must go red; mutation (M1) is the pre-change selector, under which a
# main push selected an empty range (full history).
#
# Secret fixtures are built by concatenation so gitleaks never sees a literal
# in this file's own bytes.

# shellcheck disable=SC2015,SC2016
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SA_YML="${GITLEAKS_INCR_SA_YML:-$REPO_ROOT/.github/workflows/security-audit.yml}"
NIGHTLY_YML="${GITLEAKS_INCR_NIGHTLY_YML:-$REPO_ROOT/.github/workflows/nightly.yml}"
SCAN_SH="$REPO_ROOT/scripts/security-audit-gitleaks.sh"

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== gitleaks incremental main-push scan (GITLEAKS-INCR) ==="

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-gitleaks-incr.XXXXXX")"
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

# --- extract the real step text -------------------------------------------
if ! python3 -c '
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
steps = d["jobs"]["secret-scan"]["steps"]
run = [s["run"] for s in steps if s.get("name", "").startswith("Select gitleaks scan mode")]
assert len(run) == 1
open(sys.argv[2], "w").write(run[0])
' "$SA_YML" "$TMP_ROOT/step.sh"; then
  echo "  FAIL: could not extract the scan-mode step"; exit 1
fi
STEP="$TMP_ROOT/step.sh"

_mutate() { # _mutate <dst> <old> <new> (exactly one occurrence)
  python3 -c '
import sys
s = open(sys.argv[1]).read()
assert s.count(sys.argv[3]) == 1, "anchor not found once: " + sys.argv[3]
open(sys.argv[2], "w").write(s.replace(sys.argv[3], sys.argv[4]))
' "$STEP" "$1" "$2" "$3"
}
# M1 = pre-change selector: a main push is not a selected ref at all.
_mutate "$TMP_ROOT/m1.sh" 'refs/heads/main)' 'refs/heads/main-old)'
# M3 = tip used instead of its parent when looking for the tag.
_mutate "$TMP_ROOT/m3.sh" '"${GITHUB_SHA}^" 2>/dev/null || true)"' '"${GITHUB_SHA}" 2>/dev/null || true)"'

_secret_line="const key = \"AKIA""1234567890ABCDEF\";"

_git() { git -C "$1" "${@:2}"; }
_new_repo() { # _new_repo <name> -> REPO; one commit tagged v1.0.0, bare origin with tags
  REPO="$TMP_ROOT/$1"; ORIGIN="$TMP_ROOT/$1.origin.git"
  git init -q -b main "$REPO" >/dev/null
  _git "$REPO" config user.email "incr@loki.local"
  _git "$REPO" config user.name "incr test"
  _git "$REPO" config commit.gpgsign false
  _git "$REPO" config core.hooksPath /dev/null
  : > "$REPO/.gitleaksignore"
  printf 'readme\n' > "$REPO/README.md"
  _git "$REPO" add .gitleaksignore README.md
  _git "$REPO" commit -qm baseline --no-gpg-sign --no-verify
  _git "$REPO" tag v1.0.0
}
_commit() { # _commit <repo> <path> <content>
  printf '%s\n' "$3" > "$1/$2"
  _git "$1" add "$2"
  _git "$1" commit -qm "add $2" --no-gpg-sign --no-verify
}
_origin() { git clone -q --bare "$REPO" "$ORIGIN"; _git "$REPO" remote add origin "$ORIGIN"; }
_run() { # _run <step> <repo> [ref] [event] -> prints the selected range; log in <repo>.out
  local ref="${3:-refs/heads/main}" event="${4:-push}"
  : > "$2.env"
  (cd "$2" && env GITHUB_REF="$ref" GITHUB_EVENT_NAME="$event" GITHUB_SHA="$(git rev-parse HEAD)" \
    GITHUB_ENV="$2.env" bash "$1" > "$2.out" 2>&1)
  sed -n 's/^GITLEAKS_RANGE=//p' "$2.env" | tail -1
}
_is_full() { grep -q '^gitleaks mode: full$' "$1.out"; }

# --- (a) a secret planted after the tag is inside the selected range -------
_a() { # _a <step> <name> -> 0 iff range == v1.0.0..SHA
  _new_repo "$2"
  _commit "$REPO" a.txt a
  _commit "$REPO" leak.js "$_secret_line"
  _commit "$REPO" b.txt b
  _origin
  local r sha
  r="$(_run "$1" "$REPO")"; sha="$(_git "$REPO" rev-parse HEAD)"
  [ "$r" = "v1.0.0..${sha}" ] && grep -q '^gitleaks mode: range ' "$REPO.out"
}
if _a "$STEP" a1; then ok "(a) main push selects <previous tag>..SHA"; else bad "(a) main push did not select the tag range"; fi
if _a "$TMP_ROOT/m1.sh" a2; then bad "(a) mutation M1 (pre-change selector) stayed green"; else ok "(a) mutation M1 (pre-change selector gives full history) goes red"; fi

# A tag on the tip itself must not produce an empty range (parent is used).
_new_repo a3
_commit "$REPO" a.txt a
_origin
_git "$REPO" tag v1.1.0
r="$(_run "$STEP" "$REPO")"; sha="$(_git "$REPO" rev-parse HEAD)"
if [ "$r" = "v1.0.0..${sha}" ]; then ok "(a) a tag on the tip yields the range from the previous tag, never an empty one"; else bad "(a) tag on the tip gave '${r}'"; fi
r="$(_run "$TMP_ROOT/m3.sh" "$REPO")"
if [ "$r" = "v1.0.0..${sha}" ]; then bad "(a) mutation M3 (tip instead of parent) stayed green"; else ok "(a) mutation M3 (tip instead of parent) goes red"; fi

# The real scan over the selected range catches the planted secret.
GL="$(command -v gitleaks 2>/dev/null || true)"
if [ -n "$GL" ] && [ -x "$SCAN_SH" ]; then
  _new_repo a4
  _commit "$REPO" a.txt a
  _commit "$REPO" leak.js "$_secret_line"
  _commit "$REPO" b.txt b
  _origin
  r="$(_run "$STEP" "$REPO")"
  if (cd "$REPO" && env GITLEAKS_BIN="$GL" GITLEAKS_BEFORE="" GITLEAKS_RANGE="$r" GITLEAKS_TIP="$(git rev-parse HEAD)" \
        GITLEAKS_REPORT="$REPO.report.json" bash "$SCAN_SH" > "$REPO.scan" 2>&1); then
    bad "(a) the incremental scan did not fail on a secret planted after the tag"
  else
    n="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$REPO.report.json" 2>/dev/null || echo 0)"
    [ "$n" -ge 1 ] && ok "(a) the real incremental scan catches the planted secret ($n finding)" || bad "(a) scan failed but reported no finding"
  fi
else
  echo "  SKIP: (a) real gitleaks scan (no gitleaks binary on PATH)"
fi

# --- (b) a tag that is not an ancestor falls back to full history ----------
_b() { # _b <step> <name> -> 0 iff full
  _new_repo "$2"
  _git "$REPO" tag -d v1.0.0 >/dev/null
  _git "$REPO" checkout -q -b side
  _commit "$REPO" s.txt s
  _git "$REPO" tag v9.9.9
  _git "$REPO" checkout -q main
  _commit "$REPO" a.txt a
  _origin
  local r
  r="$(_run "$1" "$REPO")"
  [ -z "$r" ] && _is_full "$REPO"
}
if _b "$STEP" b1; then ok "(b) a tag that is not an ancestor falls back to full history"; else bad "(b) non-ancestor tag did not fall back"; fi

# --- (c) missing tag, unreachable origin, empty range -> full history ------
_new_repo c1
_git "$REPO" tag -d v1.0.0 >/dev/null
_commit "$REPO" a.txt a
_origin
r="$(_run "$STEP" "$REPO")"
if [ -z "$r" ] && _is_full "$REPO"; then ok "(c) no release tag falls back to full history"; else bad "(c) missing tag did not fall back"; fi

_new_repo c2
_commit "$REPO" a.txt a
_origin
_git "$REPO" remote set-url origin "$TMP_ROOT/does-not-exist.git"
r="$(_run "$STEP" "$REPO")"
if [ -z "$r" ] && _is_full "$REPO"; then ok "(c) a failed tags fetch falls back to full history"; else bad "(c) fetch failure did not fall back"; fi

_new_repo c3
_origin
r="$(_run "$STEP" "$REPO")"
if [ -z "$r" ] && _is_full "$REPO"; then ok "(c) a root commit (no parent) falls back to full history"; else bad "(c) root commit did not fall back"; fi

_new_repo c4
_commit "$REPO" a.txt a
_origin
r="$(_run "$STEP" "$REPO" refs/heads/main workflow_dispatch)"
if [ -z "$r" ] && _is_full "$REPO"; then ok "(c) a non-push event on main stays full history"; else bad "(c) non-push event selected a range"; fi

# --- (d) train/** is unchanged ---------------------------------------------
_new_repo d1
_commit "$REPO" m.txt m
_origin
_git "$REPO" checkout -q -b train/x
_commit "$REPO" t1.txt t1
_commit "$REPO" t2.txt t2
r="$(_run "$STEP" "$REPO" refs/heads/train/x)"
base="$(_git "$REPO" merge-base origin/main HEAD)"; sha="$(_git "$REPO" rev-parse HEAD)"
if [ "$r" = "${base}..${sha}" ]; then ok "(d) train/** still scans merge-base(origin/main)..SHA"; else bad "(d) train range changed: '${r}'"; fi
_new_repo d2
_commit "$REPO" m.txt m
_origin
_git "$REPO" checkout -q -b train/x
r="$(_run "$STEP" "$REPO" refs/heads/train/x)"
if [ -z "$r" ] && _is_full "$REPO"; then ok "(d) a train tip equal to main stays full history"; else bad "(d) empty train range did not fall back"; fi

# --- workflow wiring ---------------------------------------------------------
if grep -q 'fetch-tags: true' "$SA_YML"; then ok "secret-scan checkout fetches tags"; else bad "secret-scan checkout does not fetch tags"; fi
_nightly_ok() { # _nightly_ok <nightly.yml>
  python3 -c '
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
j = d["jobs"]["gitleaks-full-history"]
# promote.yml counts a nightly as measured when a non-skipped job name starts
# with "Full suite (backstop)"; this job must never carry that prefix.
assert not j["name"].startswith("Full suite (backstop)")
assert j["name"] == "gitleaks full history (backstop)"
assert "continue-on-error" not in j
co = [s for s in j["steps"] if str(s.get("uses", "")).startswith("actions/checkout@")]
assert len(co) == 1 and co[0]["with"]["fetch-depth"] == 0
txt = open(sys.argv[1]).read()
assert "79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e" in txt
assert "bash scripts/security-audit-gitleaks.sh" in txt
assert "GITLEAKS_RANGE" not in txt.split("gitleaks-full-history:")[1].split("first-run-gate:")[0].replace("GITLEAKS_RANGE is unset", "")
' "$1" 2>/dev/null
}
if _nightly_ok "$NIGHTLY_YML"; then
  ok "nightly backstop runs the full-history scan: blocking, not named Full suite (backstop), fetch-depth 0, pinned checksum, shared script, no range"
else
  bad "nightly.yml gitleaks-full-history job is missing or weakened"
fi
python3 -c '
import sys
s = open(sys.argv[1]).read()
i = s.index("gitleaks-full-history:")
j = s.index("fetch-depth: 0", i)
open(sys.argv[2], "w").write(s[:j] + "fetch-depth: 1" + s[j + len("fetch-depth: 0"):])
' "$NIGHTLY_YML" "$TMP_ROOT/nightly_shallow.yml"
if _nightly_ok "$TMP_ROOT/nightly_shallow.yml"; then bad "mutation nightly_shallow (fetch-depth 1) stayed green"; else ok "mutation nightly_shallow (shallow nightly checkout) goes red"; fi
python3 -c '
import sys
s = open(sys.argv[1]).read()
open(sys.argv[2], "w").write(s.replace("name: gitleaks full history (backstop)", "name: Full suite (backstop) / gitleaks full history", 1))
' "$NIGHTLY_YML" "$TMP_ROOT/nightly_name.yml"
if _nightly_ok "$TMP_ROOT/nightly_name.yml"; then bad "mutation nightly_name (Full suite prefix) stayed green"; else ok "mutation nightly_name (measured-prefix job name) goes red"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
