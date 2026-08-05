#!/usr/bin/env bash
# Image provenance: signing and SBOM must run in the job that PUBLISHES the
# image, and the docs must not overclaim.
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

# Extract the publish-docker job body: from its declaration to the next
# top-level job (two-space indent + name + colon). Signing that lives anywhere
# else in the file is exactly the bug this test exists to prevent, so every
# assertion below runs against THIS slice, never the whole file.
JOB="$(mktemp)"
trap 'rm -f "$JOB"' EXIT
awk '
    /^  publish-docker:/ { injob = 1 }
    injob && /^  [a-zA-Z_-]+:[[:space:]]*$/ && !/^  publish-docker:/ { exit }
    injob { print }
' "$REL" > "$JOB"

if [ ! -s "$JOB" ]; then
    bad "could not locate the publish-docker job in release.yml"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi
ok "located the publish-docker job"

# 1. Signing must be in the publishing job. This is the whole fix: if the image
#    published, the signature ran, with no trigger in between to not fire.
if grep -q 'cosign sign --yes' "$JOB"; then
    ok "image signing runs inside publish-docker"
else
    bad "no 'cosign sign --yes' in publish-docker -- signing has moved back out of the publishing job"
fi

# 2. Keyless signing needs an OIDC token. Without id-token: write, cosign fails
#    at runtime -- and it fails in the LAST job of a release, after npm and the
#    image are already public.
# Anchored to the start of the line so the explanatory COMMENT above the
# permission cannot satisfy this check. An unanchored grep here passed a
# mutation that deleted the actual permission line and left the comment.
if grep -qE '^[[:space:]]+id-token: write' "$JOB"; then
    ok "publish-docker requests id-token: write (keyless signing needs it)"
else
    bad "publish-docker lacks 'id-token: write' -- keyless cosign will fail at runtime"
fi

# 3. Sign the DIGEST, never a tag. A signature over a mutable tag attests to
#    whatever that tag means today, which is not a guarantee at all.
if grep -qE 'loki-mode@\$\{DIGEST\}|loki-mode@\$\{\{ steps\.build\.outputs\.digest \}\}' "$JOB"; then
    ok "signing and attestation target the image digest, not a tag"
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

# 5. The SBOM must describe the IMAGE. The pre-existing SBOM workflow describes
#    the npm tarball, which omits the OS layer, Python runtime and system
#    packages that an image-based deployment actually runs.
if grep -q 'cosign attest --yes' "$JOB" && grep -q 'cyclonedx' "$JOB"; then
    ok "a CycloneDX SBOM is attested to the image"
else
    bad "no CycloneDX SBOM attestation in publish-docker"
fi

# 6. Fail loudly on an empty SBOM rather than attesting nothing. An attestation
#    over an empty predicate verifies fine and tells an auditor nothing.
if grep -q 'test -s image-sbom.cdx.json' "$JOB"; then
    ok "an empty SBOM fails the job instead of being attested"
else
    bad "no guard against attesting an empty SBOM"
fi

# 7. Docs must exist and must not overclaim. Verification instructions nobody
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

    # The signature covers the multi-arch manifest list; the SBOM is generated
    # from one resolved platform. Implying the SBOM covers both architectures
    # would be the same overclaim this whole item exists to correct.
    # Matched against the whitespace-collapsed file: the phrase wraps across a
    # line break in the prose, and a line-oriented grep silently missed it.
    if tr '\n' ' ' < "$DOC" | tr -s ' ' | grep -q 'single resolved platform'; then
        ok "doc discloses that the SBOM covers one architecture, not both"
    else
        bad "doc implies the SBOM covers every architecture in the manifest list"
    fi
else
    bad "docs/image-provenance.md missing -- verification nobody can find is not verification"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
