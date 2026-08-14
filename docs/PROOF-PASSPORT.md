# Proof Passport

Proof Passport binds a provider-neutral Outcome Contract to an existing Loki
receipt. The JSON artifact preserves the exact contract and receipt digests,
the verifier verdict, executor/verifier separation, and explicit trust
limitations.

Generate the machine-readable passport and a portable PR/CI summary together
from the installed product. The receipt argument can be a proof id from
`loki proof list` or a path to any provider's compatible `proof.json`:

```bash
loki proof passport \
  outcome-contract.json proof.json proof-passport.json \
  --repo-dir . \
  --markdown-output proof-passport.md
```

The command exits `0` only for `VERIFIED`, `1` for `FAILED`, and `2` for
`UNVERIFIABLE` or invalid input. Existing output files are never replaced
unless `--force` is supplied. Both outputs are checked before either is
written, so a conflicting Markdown path cannot leave a new JSON artifact
behind.

The Markdown artifact is suitable for a pull-request comment or
`$GITHUB_STEP_SUMMARY`. It contains the full SHA-256 evidence bindings and
trust limitations, but no repository or machine-specific paths.

Proof Passport does not currently sign the passport itself. Receipt signature
status is reported separately and must not be interpreted as a passport
signature.
