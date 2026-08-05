# Verifying the container image

Everything on this page is a command you run against the public registry and
the public sigstore transparency log. None of it requires an account with us,
and none of it trusts anything we say here: if a command below fails, the
correct conclusion is that the image is not what we claim, not that the
instructions are stale.

## What is covered, and from which version

Read this section before the commands. Provenance that claims more than it
delivers is worse than none, because it is exactly what an auditor will test.

| Artifact | Signature | SBOM |
|---|---|---|
| Container image (`asklokesh/loki-mode`) | first release after v8.5.2 | first release after v8.5.2 |
| npm tarball (`loki-mode`) | v7.4.10 and later | v7.4.10 and later |

**Images published up to and including v8.5.2 are not signed and have no SBOM.** A signing
workflow existed from v7.4.10 but was triggered on `release: published`, and
because our releases are created by a workflow using the default
`GITHUB_TOKEN`, GitHub never emitted that event. The workflow therefore never
ran on a real release, which the registry confirms: no `sha256-*.sig` tags
existed for any version through v8.5.2. Signing now runs inside the same job
that pushes the image, so it cannot be skipped by a trigger that does not fire.

We are not backfilling signatures for older tags. A signature applied today by
a different pipeline than the one that built the artifact months ago attests
to far less than it appears to, and the appearance is the dangerous part.

## Verify the signature

Requires [cosign](https://github.com/sigstore/cosign) v2.x. Substitute your
version for `8.6.0`.

Signatures are bound to the image **digest**, not to a tag. Tags are mutable --
`latest` moves every release, and even a version tag can be repointed -- so
resolve the digest first and verify that.

```sh
VERSION=8.6.0   # or whichever release first carried signing; see the table above
DIGEST=$(docker buildx imagetools inspect "asklokesh/loki-mode:${VERSION}" \
  --format '{{json .Manifest.Digest}}' | tr -d '"')
echo "$DIGEST"

cosign verify \
  --certificate-identity-regexp 'https://github.com/asklokesh/loki-mode/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "asklokesh/loki-mode@${DIGEST}"
```

The two `--certificate-*` flags are the part that matters, and omitting them
is the most common way to get a meaningless pass. Keyless signing means anyone
with a GitHub account can produce a valid sigstore signature over our image;
what makes the signature *ours* is that it was issued to our workflow identity
by GitHub's OIDC issuer. Without those flags cosign will happily confirm that
the image was signed by somebody.

A pass prints a JSON block including the certificate's subject, which should
name `release.yml` in this repository.

## Verify and read the SBOM

The SBOM is attached to the image as a CycloneDX attestation. Note this is a
*separate* artifact from the npm SBOM published on the GitHub Release: the
image carries an OS layer, a Python runtime and system packages that the npm
tarball's SBOM never described. If you are deploying by Helm, ECS, or any
other image-based path, the image SBOM is the one that matches what you run.

```sh
cosign verify-attestation \
  --type cyclonedx \
  --certificate-identity-regexp 'https://github.com/asklokesh/loki-mode/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "asklokesh/loki-mode@${DIGEST}" \
  | jq -r '.payload' | base64 -d | jq '.predicate' > image-sbom.cdx.json

jq '.components | length' image-sbom.cdx.json
```

`verify-attestation` checks the signature over the SBOM before you read it,
which is the point: an SBOM you downloaded unverified tells you what someone
wanted you to believe is in the image.

**Scope limit worth knowing.** We publish a multi-arch image (linux/amd64 and
linux/arm64). The signature covers the manifest list, so it covers both
architectures. The SBOM does not: it is generated from a single resolved
platform, so package versions specific to the other architecture may differ
from what it lists. If you deploy on arm64 and need an exact bill of materials
for that architecture, generate it against the arch-specific digest yourself:

```sh
syft "asklokesh/loki-mode:${VERSION}" --platform linux/arm64 -o cyclonedx-json
```

Feed `image-sbom.cdx.json` to Grype, Trivy, Dependency-Track or any other
CycloneDX consumer for CVE scanning.

## Air-gapped environments

Both commands above reach the public sigstore infrastructure (Rekor and
Fulcio) to check the transparency log. To verify inside an air-gapped network,
mirror the trust root and the artifacts on a connected host first:

```sh
cosign save "asklokesh/loki-mode@${DIGEST}" --dir ./loki-image-bundle
cosign initialize --mirror <your-tuf-mirror> --root <your-root.json>
```

Then transfer `loki-image-bundle/` and verify with `cosign verify --local-image
./loki-image-bundle`. See `loki doctor --airgap` for the full host inventory
the engine itself needs at runtime.

## If verification fails

Do not deploy the image. In order of likelihood:

1. **You verified a tag instead of a digest.** Re-resolve the digest.
2. **You omitted the `--certificate-*` flags**, verified a digest that was
   never ours, and got a pass or a confusing mismatch. Both flags are required.
3. **The version is v8.5.2 or earlier.** See the coverage table above; those images
   are genuinely unsigned and no command will make them verify.
4. **The image is not what we published.** Report it at
   https://github.com/asklokesh/loki-mode/issues and do not run it.
