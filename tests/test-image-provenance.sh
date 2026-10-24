#!/usr/bin/env bash
# Image provenance: signing must run in the job that PUBLISHES the image
# manifest, and the docs must not overclaim (SBOM and provenance are best effort
# steps restored by D123).
#
# WHY THIS TEST EXISTS. provenance.yml carried a header comment stating it
# "signs npm tarball + Docker image digests". That comment was true of the YAML
# and false of reality: the workflow triggers on `release: published`, our
# releases are created with the default GITHUB_TOKEN, and GitHub does not emit
# trigger events for that token. The workflow fired twice ever, both manual, in
# April. The registry proved the consequence -- zero sha256-*.sig tags across
# every published version through v8.5.2.
#
# A dead workflow leaves an EMPTY run list, not a red one, so nothing ever
# alerted. The assertions below are aimed squarely at the ways this can quietly
# revert to dead: signing moved back out of the publish job, the OIDC
# permission dropped, or a tag signed in place of a digest.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REL="$REPO_ROOT/.github/workflows/release.yml"
DOC="$REPO_ROOT/docs/image-provenance.md"

PASS=0
FAIL=0
ok()   { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Extract the docker job body: from its declaration to the next
# top-level job (two-space indent + name + colon). Signing that lives anywhere
# else in the file is exactly the bug this test exists to prevent, so every
# assertion below runs against THIS slice, never the whole file.
JOB="$(mktemp)"
trap 'rm -f "$JOB"' EXIT
awk '
    /^  docker:/ { injob = 1 }
    injob && /^  [a-zA-Z_-]+:[[:space:]]*$/ && !/^  docker:/ { exit }
    injob { print }
' "$REL" > "$JOB"

if [ ! -s "$JOB" ]; then
    bad "could not locate the docker job in release.yml"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi
ok "located the docker job"

# 1. Signing must be in the publishing job. This is the whole fix: if the image
#    published, the signature ran, with no trigger in between to not fire.
if grep -q 'cosign sign --yes' "$JOB"; then
    ok "image signing runs inside docker job"
else
    bad "no 'cosign sign --yes' in docker job -- signing has moved back out of the publishing job"
fi

# 2. Keyless signing needs an OIDC token. Without id-token: write, cosign fails
#    at runtime -- and it fails in the LAST job of a release, after npm and the
#    image are already public.
# Anchored to the start of the line so the explanatory COMMENT above the
# permission cannot satisfy this check. An unanchored grep here passed a
# mutation that deleted the actual permission line and left the comment.
if grep -qE '^[[:space:]]+id-token: write' "$JOB"; then
    ok "docker job requests id-token: write (keyless signing needs it)"
else
    bad "docker job lacks 'id-token: write' -- keyless cosign will fail at runtime"
fi

# 3. Sign the DIGEST, never a tag. A signature over a mutable tag attests to
#    whatever that tag means today, which is not a guarantee at all.
if grep -qE 'loki-mode@\$\{DIGEST\}|loki-mode@\$\{\{ steps\.build\.outputs\.digest \}\}' "$JOB"; then
    ok "signing targets the image digest, not a tag"
else
    bad "signing does not reference an image digest -- a tag-bound signature is not a content guarantee"
fi

# 4. The digest has to come from the build step's own output. Re-resolving it
#    later with a separate pull could sign a different image than the one this
#    run built, which is a race nobody would ever notice.
if grep -q 'id: build' "$JOB"; then
    ok "the build step is addressable, so the digest comes from this run's push"
else
    bad "build step has no 'id: build' -- steps.build.outputs.digest cannot resolve"
fi

# 5. Docs must exist and must not overclaim. Verification instructions nobody
#    can find are the same failure as verification that never ran -- this is
#    the pattern where signing was built, gated, and undiscoverable.
if [ -f "$DOC" ]; then
    ok "operator verification doc exists"

    # The certificate flags are what bind a signature to OUR identity. Without
    # them cosign confirms only that SOMEBODY signed it, which passes and means
    # nothing.
    if grep -q 'certificate-identity-regexp' "$DOC" && grep -q 'certificate-oidc-issuer' "$DOC"; then
        ok "doc requires the certificate identity and issuer flags"
    else
        bad "doc omits --certificate-identity-regexp / --certificate-oidc-issuer (a pass without them is meaningless)"
    fi

    # Honesty about what is NOT covered. Earlier versions are genuinely
    # unsigned; a doc implying otherwise sends an auditor chasing a command
    # that cannot succeed.
    if grep -q 'not signed' "$DOC"; then
        ok "doc states plainly that earlier images are unsigned"
    else
        bad "doc does not disclose that earlier images are unsigned"
    fi

    # D123 restored SBOMs and provenance (best effort). The doc must say so,
    # and must not keep claiming that later releases ship no SBOM.
    flat="$(tr '\n' ' ' < "$DOC" | tr -s ' ')"
    if printf '%s' "$flat" | grep -q 'ship no SBOM'; then
        bad "doc still claims releases ship no SBOM"
    elif printf '%s' "$flat" | grep -q 'attach-sbom' \
        && printf '%s' "$flat" | grep -q 'gh attestation verify' \
        && printf '%s' "$flat" | grep -q 'continue-on-error'; then
        ok "doc describes attach-sbom, continue-on-error and gh attestation verify"
    else
        bad "doc does not describe the SBOM attach job, best-effort status and gh attestation verify"
    fi

    # The workflow must actually carry what the doc promises.
    if grep -q 'anchore/sbom-action@' "$REL" && grep -q 'actions/attest-build-provenance@' "$REL" \
        && grep -q '^  attach-sbom:' "$REL"; then
        ok "release.yml has the SBOM, attestation and attach-sbom steps"
    else
        bad "release.yml lacks the SBOM, attestation or attach-sbom steps the doc describes"
    fi
else
    bad "docs/image-provenance.md missing -- verification nobody can find is not verification"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
