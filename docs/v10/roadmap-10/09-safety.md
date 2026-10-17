# 09 Safety and security

Now 8.5. Bar set by: Codex (offline agent phase, secrets stripped before the agent runs, domain allowlist), Claude Code (OS sandbox: Seatbelt on macOS, bubblewrap on Linux), Copilot (default security scans, restricted push branches).

Why we are not 10:
- `loki share` uploads a PUBLIC gist by default from `loki report` output with no redact call (`autonomy/loki` cmd_report / share). Live leak risk.
- `redact.ts` misses secret words mid-name: `AWS_SECRET_ACCESS_KEY`, `PGPASSWORD`, `MYSQL_PWD`, `DB_PASS`, `PRIVATE_KEY`, `SECRET_KEY_BASE`, `client_secret_value`; unterminated `password="...`; the `=>` form. Python `proof_redact.py` catches them (parity gap).
- URL userinfo ReDoS (2.8s on 100KB). SECURITY-26 fix `fb2408cfc` was BLOCKED: the added `\b` lets hash-glued URLs leak userinfo.
- Default agent mode is bypassPermissions; engine10 has no sandbox; the bash denylist is literal (`rm -r -f /`, `find / -delete`, `shutil.rmtree` pass).
- `policyGate` covers only the PR action and allows when no policy file exists.
- npm publish has no `--provenance`, uses a long-lived `NPM_TOKEN`; actions mostly tag-pinned.
- SARIF and `redact.ts` keep separate pattern lists; SARIF never gates.

Owns `loki-ts/src/util/redact.ts` for this program. All tests build secrets by string concatenation so gitleaks does not flag them. HIGH tier: opus adversarial reviewer on every item.

## SAFE-1 Share is private and redacted

Acceptance: `loki share` defaults to a secret gist, requires `--public` explicitly, and runs output through redaction; test with seeded secrets shows none uploaded.

Todo:
- [ ] Flip default, add redact call
- [ ] Test

## SAFE-2 Redaction parity and ReDoS

Todo:
- [ ] Rework SECURITY-26 on main: URL userinfo scheme `/([a-z][a-z0-9+.-]{0,63}:\/\/)[^\s/?#@]+@/gi` (no `\b`), regression tests for `"sha256:"+h+"https://admin:...@db"`, `h+"postgres://u:...@db"`, `"x".repeat(80)+"://u:p@h"`; ReDoS test limit 250ms
- [ ] N2: unterminated quoted values redacted
- [ ] N3: mid-name keywords (AWS_SECRET_ACCESS_KEY, PGPASSWORD, MYSQL_PWD, DB_PASS, PRIVATE_KEY, SECRET_KEY_BASE)
- [ ] N4: `=>` assignment form
- [ ] Parity test: the same corpus through `redact.ts` and `proof_redact.py` gives the same masked set

Acceptance: parity test green; adversarial 100KB and 1MB inputs linear; opus HIGH reviewer APPROVE.

## SAFE-3 Sandbox by default on engine10

Acceptance: engine10 agent runs inside the OS sandbox (Seatbelt / bubblewrap, or the provider's own sandbox) with write access limited to the worktree; `bypassPermissions` only inside the sandbox; denylist tests cover `rm -r -f /`, `find / -delete`, `python -c shutil.rmtree`.

Todo:
- [ ] Sandbox wrapper in runner
- [ ] Shape-based denylist (not literal strings)
- [ ] Escape tests

## SAFE-4 Egress allowlist and offline phase

Acceptance: optional offline agent phase after dependency install; domain allowlist enforced; secrets stripped from the agent env before the agent runs (spawn env guard extended).

Todo:
- [ ] Allowlist config plus enforcement
- [ ] Offline phase flag
- [ ] Env strip test

## SAFE-5 Policy gate everywhere

Acceptance: `policyGate` runs for commit, push, deploy and network actions; missing check.js fails closed; tests per action.

Todo:
- [ ] Extend `util/run_outputs.ts` call sites

## SAFE-6 Supply chain

Acceptance: `npm publish --provenance` via OIDC (`id-token: write`), no long-lived NPM_TOKEN; all actions SHA-pinned; SLSA provenance for the tarball; `npm view loki-mode` shows provenance.

Todo:
- [ ] release.yml publish job
- [ ] Pin actions by SHA (script plus guard)

## SAFE-7 One pattern list

Acceptance: SARIF export and `redact.ts` read one shared pattern source; SARIF can gate with `--fail-on`; drift test.

Todo:
- [ ] Shared module, delete the duplicate list
- [ ] Gate flag
