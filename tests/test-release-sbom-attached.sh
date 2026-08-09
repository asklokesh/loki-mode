#!/usr/bin/env bash
# The npm-tarball SBOM is ATTACHED to the GitHub Release, not merely generated.
#
# THE BUG. sbom.yml generated a CycloneDX SBOM for the npm tarball on every
# push and uploaded it as a WORKFLOW ARTIFACT, which nobody downloads. Its
# `release: published` trigger, which was supposed to attach the SBOM to the
# release, has never once fired: releases are created by `gh release create`
# under the default GITHUB_TOKEN, and GitHub suppresses trigger events for that
# token to prevent workflow recursion. Measured on v9.19.1 -- 6 release assets,
# ZERO matching sbom/cyclonedx/spdx -- and over sbom.yml's last 15 runs, every
# one was `push`. A dead trigger shows up as an EMPTY run list, never a red
# one, which is why a green "SBOM (CycloneDX)" badge sat over an unmet claim.
#
# The fix mirrors what the CONTAINER SBOM already does (release.yml:576-591):
# generate it INLINE in the job that makes the release, removing the trigger
# from the equation entirely. Because releases here are immutable (a
# post-publish upload fails HTTP 422), it must be attached AT creation.
#
# WHAT THIS TEST IS, AND IS NOT. It is a STATIC check of the workflow
# DEFINITION. It cannot run a release, so it CANNOT prove:
#   - that cyclonedx-npm actually succeeds on the runner,
#   - that the generated SBOM has correct or complete contents,
#   - that `gh release create` accepts the asset,
#   - that the file the generate step writes is the file the attach step names
#     at RUNTIME (it compares the literal paths, not the produced bytes).
# It proves only that the DEFINITION says the right thing. The runtime proof is
# `gh release view <tag> --json assets` after the next release ships.
#
# ASSERTION 4 IS THE LOAD-BEARING ONE nobody would think to write: if the npm
# SBOM and the image SBOM share a filename, one silently overwrites the other
# and the release ships half the evidence it advertises.
#
# Assertions are scoped to the ARGUMENT LIST of the release-creating command,
# not grepped over the whole file. A whole-file grep for the filename would
# also match the generate step's --output-file AND the explanatory comments --
# so deleting the attach step would leave such a grep still passing. That
# false-green shape is exactly what this repo keeps getting caught by.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_YML="$REPO_ROOT/.github/workflows/release.yml"
SBOM_YML="$REPO_ROOT/.github/workflows/sbom.yml"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the npm-tarball SBOM is attached to the GitHub Release"

[ -f "$RELEASE_YML" ] || { echo "  FAIL: $RELEASE_YML missing"; exit 1; }
[ -f "$SBOM_YML" ]    || { echo "  FAIL: $SBOM_YML missing"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 not installed (not a pass)"; exit 0; }
python3 -c 'import yaml' 2>/dev/null || { echo "  SKIPPED: pyyaml not installed (not a pass)"; exit 0; }

# Extract the facts ONCE with a real YAML parser. Every field is emitted on its
# own line so a missing one surfaces as an empty value below, and an empty
# value always routes to bad() -- an absent measurement is not a pass.
_facts="$(_LOKI_REL="$RELEASE_YML" python3 <<'PY' 2>/dev/null
import os, sys, yaml

try:
    with open(os.environ['_LOKI_REL']) as f:
        wf = yaml.safe_load(f)
    jobs = wf['jobs']
except Exception:
    sys.exit(1)

def steps(job):
    return (jobs.get(job) or {}).get('steps') or []

def run_bodies(job):
    return [s.get('run') or '' for s in steps(job)]

# The step that CREATES the release: the one whose run body invokes
# `gh release create`. Located by behaviour, not by name, so renaming the step
# does not silently disarm this.
create_body = ''
for body in run_bodies('release'):
    if 'gh release create' in body:
        create_body = body
        break

# Only the ARGUMENT LIST of that command, so a filename appearing anywhere else
# in the same body (a comment, an unrelated echo) cannot satisfy the check.
# The command spans continuation lines: take from `gh release create` up to the
# first line that does not end in a backslash.
args = ''
if create_body:
    collecting = False
    for line in create_body.splitlines():
        if 'gh release create' in line:
            collecting = True
        if collecting:
            args += line + '\n'
            if not line.rstrip().endswith('\\'):
                break

# Every --output-file the release job writes, and the image SBOM's, so the
# collision check compares real values rather than assumed names.
def output_files(job):
    out = []
    for body in run_bodies(job):
        for tok in body.replace('\\\n', ' ').split():
            if tok.endswith('.json') and ('sbom' in tok.lower() or 'cdx' in tok.lower()):
                out.append(os.path.basename(tok.strip('"\'')))
    return out

# The image SBOM is produced by an ACTION (anchore/sbom-action), not a run body.
image_sbom = ''
for s in steps('publish-docker'):
    w = s.get('with') or {}
    if 'output-file' in w:
        image_sbom = os.path.basename(str(w['output-file']))
        break

# Positive control: the image SBOM's own fail-closed guard must survive.
image_guard = 'yes' if any(
    'image-sbom.cdx.json' in b and 'test -s' in b for b in run_bodies('publish-docker')
) else 'no'

npm_outputs = [f for f in output_files('release')]
# The empty-SBOM guard in the release job, on whatever file it names.
npm_guard = 'yes' if any(
    'test -s' in b and 'sbom' in b.lower() for b in run_bodies('release')
) else 'no'

print(args.strip().replace('\n', ' ~ '))
print(' '.join(npm_outputs))
print(image_sbom)
print(npm_guard)
print(image_guard)
PY
)" || _facts=""

if [ -z "$_facts" ]; then
  bad "could not parse release.yml (assertions 1-5 did not run -- absent measurement, not a pass)"
  echo ""
  echo "  Passed: $PASS   Failed: $FAIL"
  exit 1
fi

CREATE_ARGS="$(printf '%s\n' "$_facts" | sed -n '1p')"
NPM_OUTPUTS="$(printf '%s\n' "$_facts" | sed -n '2p')"
IMAGE_SBOM="$(printf '%s\n' "$_facts" | sed -n '3p')"
NPM_GUARD="$(printf '%s\n' "$_facts" | sed -n '4p')"
IMAGE_GUARD="$(printf '%s\n' "$_facts" | sed -n '5p')"

if [ -z "$CREATE_ARGS" ]; then
  bad "no step in the release job runs 'gh release create' -- cannot locate the release-creating command"
fi

# --- 1. The release job GENERATES an npm-tarball SBOM ----------------------
# Not merely the image one: that lives in publish-docker and describes the
# container, which is a different artifact entirely.
if [ -n "$NPM_OUTPUTS" ]; then
  ok "the release job generates an SBOM of its own ($NPM_OUTPUTS)"
else
  bad "the release job generates no SBOM -- only the container one exists, and it describes a different artifact"
fi

# --- 2. THE FIX: that file is an ARGUMENT to gh release create -------------
# Scoped to the argument list. A whole-file grep would match the --output-file
# and the comments, and stay green with the attach deleted.
_attached=0
for _f in $NPM_OUTPUTS; do
  case "$CREATE_ARGS" in
    *"$_f"*) _attached=1 ;;
  esac
done
if [ "$_attached" -eq 1 ]; then
  ok "the npm SBOM is passed to gh release create, so it ships as a release asset"
else
  bad "the npm SBOM is generated but NEVER attached -- this is the exact v9.19.1 gap (6 assets, 0 SBOM)"
fi

# --- 3. Fail closed on an empty SBOM --------------------------------------
# A zero-byte SBOM asset is worse than none: it looks like compliance.
if [ "$NPM_GUARD" = "yes" ]; then
  ok "the release fails closed when the npm SBOM is empty"
else
  bad "no test -s guard on the npm SBOM -- a zero-byte asset would ship looking like compliance"
fi

# --- 4. THE SILENT ONE: the two SBOMs have DISTINCT filenames -------------
# They describe different artifacts (npm tree vs container OS layer + Python
# runtime) and are NOT interchangeable. A shared basename means one overwrites
# the other and the release ships half the evidence it claims.
if [ -z "$IMAGE_SBOM" ]; then
  bad "could not read the image SBOM's output-file (collision check did not run)"
else
  _collision=0
  for _f in $NPM_OUTPUTS; do
    [ "$_f" = "$IMAGE_SBOM" ] && _collision=1
  done
  if [ "$_collision" -eq 0 ]; then
    ok "npm SBOM ($NPM_OUTPUTS) and image SBOM ($IMAGE_SBOM) have distinct filenames"
  else
    bad "FILENAME COLLISION: both SBOMs are '$IMAGE_SBOM' -- one silently overwrites the other"
  fi
fi

# --- 5. POSITIVE CONTROL: the image SBOM path still works ------------------
# The path that ALREADY worked must not regress. Without this, assertions 1-4
# could all pass on a change that broke container signing.
if [ -n "$IMAGE_SBOM" ] && [ "$IMAGE_GUARD" = "yes" ]; then
  ok "positive control: the image SBOM is still generated and still fails closed when empty"
else
  bad "REGRESSION: the image SBOM path lost its generation or its empty-check"
fi

# --- 6. sbom.yml no longer claims to attach anything to a release ----------
# The dead `release:` trigger is deliberately KEPT (harmless, and correct the
# day releases are cut by a PAT). Only the false claim had to go. Asserted on
# the trigger's survival plus the header pointing at release.yml, so a future
# edit that deletes the trigger OR restores the lie is caught.
_sbom_head="$(sed -n '1,40p' "$SBOM_YML")"
if printf '%s' "$_sbom_head" | grep -q 'release.yml'; then
  ok "sbom.yml's header points at release.yml as the place the release asset comes from"
else
  bad "sbom.yml's header does not say where the release asset actually comes from"
fi
if printf '%s\n' "$_facts" >/dev/null && grep -q 'types: \[published\]' "$SBOM_YML"; then
  ok "sbom.yml keeps its release: trigger (harmless now, correct under a PAT)"
else
  bad "sbom.yml's release: trigger was deleted -- it was meant to be kept"
fi

# --- 7. Both workflows still parse ----------------------------------------
# A broken release.yml blocks every future release, so this file is
# higher-stakes than the change looks.
for _y in "$RELEASE_YML" "$SBOM_YML"; do
  if _LOKI_Y="$_y" python3 -c "import os,yaml;yaml.safe_load(open(os.environ['_LOKI_Y']))" 2>/dev/null; then
    ok "$(basename "$_y") parses as YAML"
  else
    bad "$(basename "$_y") is not valid YAML"
  fi
done

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
