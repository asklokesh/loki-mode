# pub-pyjwt-1147 provenance (not given to arms)

- issue: jpadilla/pyjwt#1147
- fix_pr: jpadilla/pyjwt#1148 (https://github.com/jpadilla/pyjwt/pull/1148)
- merge_sha: bd9700cca7f9258fadcc429c1034e508025931f2
- repo.ref (red) = merge^1: 051ea341b5573fe3edcd53042f347929b92c2b92
- source files touched (medium: >=2): jwt/api_jws.py, jwt/api_jwt.py
- `git diff --stat ref merge`: CHANGELOG.rst, jwt/api_jws.py (+9 -2), jwt/api_jwt.py (+2 -2), tests/test_api_jws.py (+21), tests/test_api_jwt.py (+17); the two tests files are the hidden files
- hidden files (upstream at merge_sha, one edit): tests/test_api_jws.py, tests/test_api_jwt.py. The only change renames the path segment "Users" to "Accounts" in the scim.example.com example URL (one line in each file, a round-tripped claim value), so no hardcoded-path pattern appears in the task tree; RED/GREEN were re-run after the edit.
- prompt: the issue text with the 2000-char RSA private JWK elided to `...` and the System Information block dropped.
- hidden.run runs both whole files, no -k: RED at ref = 2 failed, 161 passed, 1 skipped (rc=1); GREEN at merge = 163 passed, 1 skipped (rc=0).
- issue reproducer at ref: encode with a PyJWK and no algorithm argument uses HS256 instead of the key's algorithm (the new tests assert HS384 from an "oct" JWK; at ref jws raises InvalidAlgorithmError). Fails at ref, so not already fixed.
- (a) single-file check (each file's diff applied alone to ref, hidden.run): api_jws.py only = 1 failed (test_api_jwt encode test still red, rc=1); api_jwt.py only = collection error, ImportError of the sentinel (rc=1). Neither alone passes.
- (c) plausible wrong fix rejected: patching only PyJWS.encode (api_jws.py), the path the issue's traceback names, leaves PyJWT.encode hard-coding "HS256", and test_api_jwt.py::test_encode_with_jwk_uses_key_algorithm fails (rc=1).
- (e) deletion mutant at merge (unset-algorithm branch in api_jws.py forced to "HS256" for a PyJWK key): 2 failed, rc=1. No-op baseline through run.sh (STUB_MODE=noop, absolute LOKI_EVAL_CLAUDE_BIN): status=ok, completed=False.
- Verified on Python 3.14.6 with cryptography installed; no network at test time.
