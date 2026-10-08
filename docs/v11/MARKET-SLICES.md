# Market program slice cards (source: autonomi-dev/research/2026-10-08-market/MARKET.md)

Owner: Product Owner. Not committed to BOARD.md. Cards are at most 60 lines each. Shared Wall checks on every card: tsc clean (loki-ts), only the file set listed is touched, bash -n on touched shell, no emoji or dash characters, SKILL.md untouched, dist rebuilt when loki-ts/src changes (memory: ts edit needs dist rebuild), new test files registered in the runner and shard table (structural guards). Budgets: LOW 15 min, MEDIUM 30 min, HIGH 30 min build plus live pair review (D91-8). Every flag is default OFF unless the card says otherwise. Staffing order is the section order.

# STANDARDS

## Program 1: MCP-2026-07-28 (write-first card)

Ground truth read from code (2026-10-08):
- Two separate MCP stacks. (a) Python `mcp/server.py` (FastMCP from the pip SDK via `mcp/_sdk_loader.py`; `mcp/lsp_proxy.py` is a second server on the same loader). The protocol version it advertises is whatever the SDK negotiates; installed SDK is mcp 1.27.0 whose `LATEST_PROTOCOL_VERSION` is 2025-11-25; `mcp/requirements.txt` and `requirements-test.txt` pin `mcp>=1.0.0,<2.0.0`. So Python does NOT advertise 2024-11-05; it is capped at 2025-11-25 by the SDK. (b) Hand-rolled JS `src/protocols/mcp-server.js:97` and `mcp-client.js:105`, hardcoded 2024-11-05.
- JS server defects beyond the version string: `initialize` ignores `params.protocolVersion`, returns the version inside `serverInfo` (spec puts `protocolVersion` at `result` top level), accepts only the legacy `initialized` method (spec name is `notifications/initialized`), and the client sends the same legacy name. These are fixed by MCP-A regardless of spec target.
- No code anywhere implements `server/discover`, `_meta.traceparent`, or the tasks extension (grep: 0 hits in mcp/ and src/).
- Existing tests to extend, not duplicate: `tests/protocols/mcp-server.test.js:191` (pins 2024-11-05), `tests/protocols/mcp-client.test.js`, `tests/test-mcp-server.sh`, `tests/test-mcp-http-auth.sh:115` (sends 2025-06-18), `tests/cli/test-mcp-launch.sh:278` (sends 2024-11-05), `tests/test-mcp-tool-surface-packaged.sh`.
- Uncertainty to resolve first (MCP-0): the market report says 2026-07-28 is stateless (no initialize), with `server/discover`, Multi Round-Trip Requests, Tasks as extension `io.modelcontextprotocol/tasks`, Roots/Sampling/Logging deprecated. The pip SDK 1.x has no such support (inferred; verify). Do not hand-roll the Python side if an SDK release exists.

### MCP-0 Spec and SDK probe (LOW, 15 min)
- Goal: a checked-in, cited conformance table: which 2026-07-28 requirements apply to Loki (a stdio tool server and a client), and whether any published `mcp` pip release or `@modelcontextprotocol/sdk` npm release implements it.
- File set: docs/v11/MCP-2026-07-28.md (new). No code.
- Tests first: tests/test-mcp-spec-doc.sh asserts the doc names each of: server/discover, initialize removal, MRTR, tasks extension id, traceparent in _meta, deprecated Roots/Sampling/Logging/DCR, and has a "Python SDK latest version found" line with a PyPI version number and date.
- Wall: doc cites the spec changelog URL and fetch date; every claim marked verified or UNVERIFIED; no code changed.
- Commands: bash tests/test-mcp-spec-doc.sh; python3 -c "import importlib.metadata as m;print(m.version('mcp'))"; npm view @modelcontextprotocol/sdk version time.
- Flag: none. Tier LOW. Blocks MCP-C and MCP-D design, not MCP-A.

### MCP-A JS server and client: version negotiation and legacy-compat fixes (MEDIUM, 30 min)
- Goal: JS server negotiates `protocolVersion` correctly across a supported list (2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25; add 2026-07-28 only after MCP-C), returns it at `result.protocolVersion`, accepts both `initialized` and `notifications/initialized`; client sends `notifications/initialized` and the highest version it supports, and adopts the server's reply.
- File set: src/protocols/mcp-server.js, src/protocols/mcp-client.js, tests/protocols/mcp-server.test.js, tests/protocols/mcp-client.test.js. Nothing else.
- Tests first (red before green): requested 2025-06-18 gets 2025-06-18 back; unknown future version gets the server's latest supported; result has top-level protocolVersion and serverInfo has none; `notifications/initialized` returns null; client handshake against the in-test server ends on the negotiated version; old test at line 191 rewritten, not deleted.
- Wall: zero new dependencies; a 2024-11-05 client still works (regression test); getCapabilities unchanged.
- Commands: node --test tests/protocols/mcp-server.test.js tests/protocols/mcp-client.test.js; bash tests/test-mcp-server.sh.
- Flag: none (bug fix; old clients stay supported). Tier MEDIUM.

### MCP-B Python server: advertised-version regression guard and SDK bump path (LOW, 15 min)
- Goal: a test that handshakes `python -m mcp.server` over stdio and records the negotiated version, so an SDK bump that changes it is visible; raise the pin ceiling only to a release MCP-0 shows supports a newer spec, otherwise keep <2.0.0 and record why in the doc.
- File set: tests/test-mcp-protocol-version.sh (new), mcp/requirements.txt and requirements-test.txt (only if MCP-0 finds a supporting release).
- Tests first: handshake with 2025-11-25 returns 2025-11-25; handshake with 2024-11-05 returns 2024-11-05; both exit 0; reuse the handshake helper in tests/test-mcp-tool-surface-packaged.sh rather than writing a new one.
- Wall: tool surface guard (test-mcp-tool-surface-guard-rejects.sh) still green; runner and shard registration present.
- Commands: bash tests/test-mcp-protocol-version.sh; bash tests/test-mcp-tool-surface-packaged.sh.
- Flag: none. Tier LOW.

### MCP-C 2026-07-28 stateless profile and server/discover (MEDIUM, 30 min; depends on MCP-0 and MCP-A)
- Goal: JS server answers `server/discover` (name, version, supported versions, capabilities) and serves tools/list and tools/call without a prior initialize when the request carries protocol version metadata per the spec; Python side gets the same only via the SDK (this slice documents the gate, adds no hand-rolled Python protocol).
- File set: src/protocols/mcp-server.js, tests/protocols/mcp-server.test.js, docs/v11/MCP-2026-07-28.md (conformance rows flip to done).
- Tests first: discover returns every supported version including 2026-07-28; stateless tools/list works with no prior initialize; legacy stateful flow still works; unknown method gives -32601.
- Wall: write/spawn tools stay behind the existing auth and read-only split (docs/v10/CP-ASK-PLAN.md); no session ids stored.
- Commands: node --test tests/protocols/mcp-server.test.js.
- Flag: LOKI_MCP_2026_07=1 enables advertising 2026-07-28; default off until MCP-0 conformance rows all pass.

### MCP-D Tasks extension, traceparent propagation (HIGH, 30 min plus pair review; depends on MCP-C and OTEL-GENAI OTEL-1)
- Goal: expose `loki run` and `loki verify` as MCP Tasks under `io.modelcontextprotocol/tasks` (create, status poll, result, cancel), and read `_meta.traceparent` on incoming calls so the run's spans use it as parent. Verify exposure is HIGH (verifier path): the task wrapper may only call the existing `loki_v10_verify` / `loki_v10_run` (mcp/v10_tools.py) and may never change a verdict.
- File set: src/protocols/mcp-server.js, mcp/v10_tools.py (read-only adapter only), tests/protocols/mcp-tasks.test.js (new), tests/test-mcp-tasks-verify-readonly.sh (new).
- Tests first: task create returns a task id; poll sees working then completed; cancel stops the child by recorded PID only; a task result for verify is byte-identical to the direct tool result; traceparent in _meta becomes the parent of the first span (assert via OTEL-1 exporter fixture); verdict upgrade attempt is refused.
- Wall: auth token required for task creation over HTTP (test-mcp-http-auth.sh extended); no kill by name or pattern.
- Commands: node --test tests/protocols/mcp-tasks.test.js; bash tests/test-mcp-tasks-verify-readonly.sh; bash tests/test-mcp-http-auth.sh.
- Flag: LOKI_MCP_TASKS=1. Tier HIGH.

## Program 2: OTEL-GENAI

Ground truth: `src/observability/{otel.js,spans.js,otel-bridge.js,index.js}` is a minimal OTLP/HTTP+JSON exporter, lazy and no-op unless LOKI_OTEL_ENDPOINT is set; the bridge (started by autonomy/run.sh:2860) tails the legacy event stream and emits `rarv.iteration` and `loki.session` spans. Engine10 writes `.loki/runs/<id>/events.jsonl` (loki-ts/src/engine10/events.ts, fold/tail) and has cost harvesting in engine10/cost.ts. Neither emits `gen_ai.*` (grep: 0). Reuse the bridge exporter; do not add an OTel SDK dependency.

### OTEL-1 Engine10 events to gen_ai spans (MEDIUM, 30 min)
- Goal: for every engine10 run, the bridge emits `invoke_agent` (run), one child per stage, `execute_tool` per tool event when present, with `gen_ai.operation.name`, `gen_ai.agent.name=loki`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens` from the cost events; semconv version pinned in one constant; trace id written to the receipt as `trace_id` only when tracing was on.
- File set: src/observability/genai-spans.js (new, pure mapper event to span), src/observability/otel-bridge.js (call mapper), tests/observability/genai-spans.test.js (new). Receipt field is OTEL-2.
- Tests first: fixture events.jsonl (with and without cost data) maps to the exact span tree and attribute names; unknown cost stays absent, never 0 (matches cost.ts UNKNOWN rule); semconv pin constant asserted; mapper pure, no network.
- Wall: zero overhead when LOKI_OTEL_ENDPOINT unset (existing no-op test stays green); no prompt or completion content in spans (opt-in content capture is out of scope).
- Commands: node --test tests/observability/genai-spans.test.js; bash tests/test-otel*.sh (existing).
- Flag: LOKI_OTEL_GENAI=1 (default off; spans only add when an endpoint is set). Tier MEDIUM.

### OTEL-2 Trace id in the receipt and import fixture (HIGH, 30 min plus pair review)
- Goal: seal.ts records `trace_id` in the receipt body (inside the signed content) so a viewer can link receipt to trace; plus a documented collector config that imports unmodified into Grafana/Honeycomb/Datadog (docs only, no vendor test).
- File set: loki-ts/src/engine10/stages/seal.ts, loki-ts/src/engine10/events.ts (envelope field only), docs/AGENT-CHANGE-RECEIPT.md (Fields table), tests under loki-ts/test for seal receipt shape.
- Tests first: receipt without tracing is byte-identical to today (golden); with tracing, trace_id is present, 32 hex, covered by the existing signature check; tamper test flips trace_id and verify returns TAMPERED.
- Wall: Seal change, so HIGH; verdict logic untouched; schema id loki.v10.receipt/1 stays (additive optional field) unless reviewers require /2.
- Commands: cd loki-ts && bun test seal verify; bash tests/test-receipt*.sh.
- Flag: only populated when OTEL-1 flag is on. Tier HIGH.

## Program 3: SARIF

Ground truth: SARIF exists only in Loki's own CI (.github/workflows/security-audit.yml CodeQL). Engine10 verify has no SAST step and no finding schema; `autonomy/lib/secret-scan.sh` is the only scanner in autonomy/lib. The issue-to-pr Action already splits read-only agent job from privileged steps (docs/AGENT-CHANGE-RECEIPT.md, Rule of Two); the SARIF upload needs `security-events: write`, so it MUST be a separate no-agent job.

### SARIF-1 Findings to SARIF 2.1.0 converter (LOW, 15 min)
- Goal: pure function turning Loki findings (secret-scan hits, NOT PROVEN items as `note` level, wall/verify failures) into a valid SARIF 2.1.0 file with stable `partialFingerprints`.
- File set: loki-ts/src/features/sarif.ts (new), loki-ts/test/sarif.test.ts (new).
- Tests first: golden SARIF for 3 findings; schema-required fields present; NOT PROVEN maps to level note with ruleId loki/not-proven; fingerprint stable across line shifts; no secret value ever appears in the output (assert redaction using util/redact.ts).
- Wall: no network, no new dependency; secret text redacted.
- Commands: cd loki-ts && bun test sarif.test.ts && bunx tsc --noEmit.
- Flag: none (library). Tier LOW.

### SARIF-2 `loki export --sarif` and receipt reference (MEDIUM, 30 min; after SARIF-1)
- Goal: `loki export --sarif [run-id]` writes `.loki/runs/<id>/findings.sarif`; also runs secret-scan on the run diff as the first finding source. No verdict change: findings are reported, not gating, in this slice.
- File set: loki-ts/src/commands/export_sarif.ts (new), registration in loki-ts/src/cli.ts and autonomy/loki dispatch, loki-ts/test/export_sarif.test.ts, completion.ts entry.
- Tests first: fixture run dir yields a file; unknown run exits 66 (match verify); help text lists flag; new-command cross-cutting registration checks (completion, help, docs) pass.
- Wall: structural guards for new command registration (memory: new-command cross-cutting).
- Commands: cd loki-ts && bun test export_sarif.test.ts; bash tests/test-completion*.sh.
- Flag: none (explicit command). Tier MEDIUM.

### SARIF-3 Upload job in issue-to-pr Action (MEDIUM, 30 min; after SARIF-2)
- Goal: opt-in `sarif: true` input uploads findings.sarif via `github/codeql-action/upload-sarif` in a second job with no agent and `security-events: write`; the agent job keeps read-only permissions.
- File set: .github/actions/issue-to-pr/action.yml, docs/AGENT-CHANGE-RECEIPT.md (or docs/alternative-installations.md section), tests/test-action-sarif-split.sh (new, YAML assertion).
- Tests first: assert agent job permissions contain no security-events: write; upload step is in a job with no loki run step; action pins by version tag consistent with existing attest step.
- Wall: Rule of Two guard; secrets never in the upload job env.
- Commands: bash tests/test-action-sarif-split.sh; actionlint if installed.
- Flag: input sarif default false. Tier MEDIUM.

## Program 4: SIGSTORE-RECEIPTS

Ground truth: Ed25519 receipt signing lives in loki-ts/src/util/receipt_signer.ts and engine10/stages/seal.ts, keys managed by engine10/keys_cmd.ts; `loki verify` is engine10/verify_cmd.ts (exit codes 0..4, 66); DSSE export exists (loki-ts/src/features/receipt_dsse.ts: in-toto Statement v1, custom predicate https://autonomi.dev/loki/receipt/v10, subject git commit and tree). GPG exists in autonomy/loki. Release images are cosign-keyless signed in release.yml. The issue-to-pr Action already has opt-in `attest: true` using actions/attest-build-provenance@v2 over receipt.json (docs/AGENT-CHANGE-RECEIPT.md "GitHub attestation"). SLSA: 0 hits. So the gap is narrower than the report says: not "no keyless", but (a) the attestation subject is receipt.json bytes, not the git commit, (b) no SLSA provenance predicate, (c) no cosign path.

### SIGS-1 SLSA v1 provenance predicate mapping (HIGH, 30 min plus pair review)
- Goal: `loki verify --export-dsse --predicate slsa` emits an in-toto Statement v1 with predicateType https://slsa.dev/provenance/v1, subject = git commit (as today), buildDefinition (buildType URL under autonomi.dev, externalParameters = issue ref, internalParameters = provider, model, harness version) and runDetails (builder.id, metadata.invocationId = run id, byproducts = receipt sha256), with the full Loki receipt referenced, not duplicated. Default predicate stays unchanged.
- File set: loki-ts/src/features/receipt_slsa.ts (new), loki-ts/src/engine10/verify_cmd.ts (flag parsing only), loki-ts/test/receipt_slsa.test.ts, docs/AGENT-CHANGE-RECEIPT.md section.
- Tests first: golden statement; verifyEnvelope accepts it with the same Ed25519 key; verify of a slsa envelope returns the same verdict as the underlying receipt; refuses to export non-VERIFIED outcomes exactly like today; tamper of buildDefinition fails signature.
- Wall: Seal-adjacent, never changes the Seal or verdict; no new key type.
- Commands: cd loki-ts && bun test receipt_slsa receipt_dsse; tsc.
- Flag: --predicate slsa (explicit). Tier HIGH.

### SIGS-2 Keyless Sigstore bundle for the DSSE envelope (HIGH, 30 min plus pair review; after SIGS-1)
- Goal: a CI-only helper that signs the DSSE statement with cosign keyless (`cosign attest-blob --predicate ... --type slsaprovenance1` or `gh attestation` with subject = commit digest) so `cosign verify-blob-attestation` and `gh attestation verify` pass without Loki installed. Local runs keep Ed25519; keyless is never attempted offline.
- File set: .github/actions/issue-to-pr/action.yml (extend existing attest job to attest the SLSA statement; keep it in the separate no-agent job), scripts/sigstore-attest.sh (new, thin), tests/test-sigstore-attest-dryrun.sh (new; stub cosign on PATH), docs/AGENT-CHANGE-RECEIPT.md.
- Tests first: dry-run with stub cosign records the exact argv (subject digest, predicate type, identity flags); script refuses when ACTIONS_ID_TOKEN_REQUEST_URL unset; agent job still lacks id-token: write (YAML assertion).
- Wall: Rule of Two; real Sigstore call only in a manual workflow_dispatch smoke documented, not in CI.
- Commands: bash tests/test-sigstore-attest-dryrun.sh; shellcheck scripts/sigstore-attest.sh.
- Flag: input attest-slsa default false. Tier HIGH.

### SIGS-DOC in-toto agent-change predicate proposal (LOW, 15 min)
- Goal: docs-only draft following the in-toto attestation New Predicate Guidelines: name, type URI, fields (task source, base commit, head commit, agent identity, model ids, tools and MCP servers used, checks run, outcome, not-proven list), a worked example derived from a real receipt, Loki as reference implementation. Describe the proposal only; state it is a draft, not accepted.
- File set: docs/v11/INTOTO-AGENT-CHANGE-PREDICATE.md (new), test tests/test-predicate-doc.sh (asserts the example JSON parses and its field names match docs/AGENT-CHANGE-RECEIPT.md).
- Wall: no claim of standardization; no URL invented for an upstream PR.
- Commands: bash tests/test-predicate-doc.sh. Flag: none. Tier LOW.

## Program 5: AI-ACT-MARKING (deadline before 2026-12-02)

Ground truth: seal.ts:138 already commits with trailer `Loki-Run: <runId>`; receipt carries provider and model (seal.ts:323). No AI-generated marker, no per-change BOM, no evidence-pack export (grep AI Act: 0). `.github/workflows/sbom.yml` produces a release CycloneDX SBOM only. Whether source code counts as "text" under Art 50 is unsettled (report). Language rule for all docs and CLI text in this program: describe what the feature writes; never state or imply compliance, legal sufficiency or certification.

### MARK-1 Commit trailers and PR marker (HIGH, 30 min plus pair review)
- Goal: every Loki commit gets machine-readable trailers: `AI-Generated: true`, `AI-Provider: <p>`, `AI-Model: <m>`, `Loki-Receipt: <run-relative path or URL>` next to existing `Loki-Run`; PR body gets a single marker line and receipt link (pr_body.ts). The commit stage is in seal.ts, so HIGH.
- File set: loki-ts/src/engine10/stages/seal.ts (commit args only), loki-ts/src/engine10/pr_body.ts, loki-ts/test (seal commit trailer test, pr_body golden), docs/environment-variables.md.
- Tests first: `git interpret-trailers --parse` on the produced commit returns all four keys; commit body without the flag byte-identical to today; PR body stays within PR_BODY_LINE_BUDGET (60).
- Wall: receipt hash and verdict untouched; trailer values sanitized (no newlines); no co-author line (repo rule).
- Commands: cd loki-ts && bun test seal pr_body; tsc.
- Flag: LOKI_AI_MARKING=1 (default ON from the release before 2026-12-02 after a founder decision; ship OFF first). Tier HIGH.

### MARK-2 Per-change AI-BOM (CycloneDX 1.7 ML-BOM block) (MEDIUM, 30 min)
- Goal: `.loki/runs/<id>/ai-bom.cdx.json` with the models (provider, id, version when known, UNKNOWN otherwise), tools, MCP servers (from loki-ts/src/providers/mcp_config.ts), harness version, plus the receipt sha256 as a property.
- File set: loki-ts/src/features/ai_bom.ts (new), loki-ts/test/ai_bom.test.ts. Writer hook is MARK-3.
- Tests first: golden for claude and codex fixture runs; unknown model version stays "unknown", never invented; validates required CycloneDX fields (bomFormat, specVersion, metadata, components).
- Wall: no network; pure over receipt plus config.
- Commands: cd loki-ts && bun test ai_bom; tsc. Flag: none (library). Tier MEDIUM.

### MARK-3 `loki export --evidence-pack` (MEDIUM, 30 min; after MARK-1, MARK-2, SIGS-1 optional)
- Goal: one directory or tarball with receipt.json, DSSE envelope, AI-BOM, trailers log (`git log --format` of run commits), and a README that states what each file is and explicitly that it is evidence, not a compliance determination.
- File set: loki-ts/src/commands/export_evidence.ts (new), cli.ts and autonomy/loki dispatch registration, completion.ts, loki-ts/test/export_evidence.test.ts, docs/AGENT-CHANGE-RECEIPT.md.
- Tests first: fixture run produces the 5 files; a grep guard test fails if README or help text contains the words "compliant", "compliance achieved", "certified" (the guard asserts absence from generated text and docs for this feature); unknown run exits 66.
- Wall: new-command registration guards; no emoji or dashes.
- Commands: cd loki-ts && bun test export_evidence; bash tests/test-completion*.sh. Flag: explicit command. Tier MEDIUM.

# HUMAN-TIME and TRUST

## Program 6: QUOTA-FORECAST

Ground truth (GOV-MEASURE exists, do not rebuild): `scripts/usage-governor.py` has `parse_usage_text` (parses `claude -p /usage --output-format json` into session_pct, week_pct, session_resets, week_resets, regexes at lines 396-397), `_run_usage_command` (bounded, process-group kill), `measured_usage` (15 min cache), `fit_tokens_per_percent`, and `--json` output. Caveats found in the code: (1) `last_wednesday_reset`/`next_wednesday_reset` hardcode the founder's weekly reset day, so they cannot be reused for a user; the user's reset must come from `session_resets`/`week_resets` text. (2) The reset fields are raw strings, not timestamps. (3) Only Claude has `/usage`; codex and others have no reading, so forecast must degrade to "unmeasured" (never a made-up number). Consumer today: `loki-ts/src/commands/queue.ts` `defaultGovernor` (shells out to the script, holds the queue on hold_above_70_session). Hard caps today: `--max-cost` (engine10/cli.ts:36, default $100 with API key, none on subscription) and the wall-clock cap (util/run_cap.ts). The F2 rough-prior cost estimate was merged (needs reading before PRED-1; locate with git log --grep F2-ROUGH-PRIOR). The user's own usage is read only on the user's machine via their own claude CLI; nothing is sent anywhere.

### QF-1 Reset-time parser and window model (LOW, 15 min)
- Goal: pure function `parseResetText(s, now, tz)` returning an epoch for strings like the /usage output (formats to be captured from tests/fixtures of real `/usage` text already used by the governor tests), or null; plus a `UsageWindow` type {kind, used_pct, resets_at|null}.
- File set: loki-ts/src/util/usage_window.ts (new), loki-ts/test/usage_window.test.ts (new). Python script untouched.
- Tests first: every distinct reset string in the existing governor test fixtures (grep tests for "resets") parses to the right epoch across a DST boundary; unparseable returns null, never now+5h; no hardcoded weekday.
- Wall: no spawn, no network; reads no files.
- Commands: cd loki-ts && bun test usage_window; tsc. Flag: none (library). Tier LOW.

### QF-2 Forecast before run and `issues run` (MEDIUM, 30 min; after QF-1)
- Goal: before `loki start` and `loki queue run` (the existing issue loop), print `forecast: ~X% of session window, ~Y% of week (basis: N past runs of this shape | rough prior | unmeasured)`. Reuse `defaultGovernor`'s script call, extended to return session_pct/week_pct/resets via `--json` (already in output). Basis uses engine10/cost.ts history when present, else the labelled rough prior, else prints "unmeasured" without a number.
- File set: loki-ts/src/engine10/forecast.ts (new), loki-ts/src/engine10/cli.ts (one call site), loki-ts/src/commands/queue.ts (one call site, reuse defaultGovernor), loki-ts/test/forecast.test.ts.
- Tests first: stub governor JSON gives the expected line; no reading gives "unmeasured" and no percent; forecast never written into the receipt as a measured value; output stays within narrow terminal width (util/term_width.ts).
- Wall: forecast is advisory, adds no new spawn beyond the existing cached read; runs must not slow by more than the cache hit path.
- Commands: cd loki-ts && bun test forecast queue; tsc. Flag: LOKI_FORECAST (default on, `=0` off) once QF-2 review passes. Tier MEDIUM.

### QF-3 Hard cap default and pause-until-reset (HIGH, 30 min plus pair review; after QF-1, QF-2)
- Goal: a window cap on by default (default stop at 90% of the session window, configurable): when the reading shows the window exhausted or the forecast exceeds remaining, the run checkpoints (existing runner/checkpoint.ts) and the queue pauses, then auto-resumes at the parsed reset time; never enables or spills into paid overage; receipt records `stop_reason: quota_window`. Touches budget stop semantics and the receipt outcome set, so HIGH.
- File set: loki-ts/src/engine10/quota_cap.ts (new), loki-ts/src/commands/queue.ts (pause/resume loop, uses injected clock), loki-ts/src/engine10/supervisor.ts (cap hook only), loki-ts/test/quota_cap.test.ts, loki-ts/test/queue_resume.test.ts.
- Tests first (fake clock, stub governor): window exhausted pauses and does not start the next item; resume fires at resets_at plus jitter, not before; unmeasured window never silently disables the cap (it falls back to the wall-clock cap and says so); a paused queue survives process restart (state file); outcome is never mislabeled VERIFIED.
- Wall: sleep implemented as a timer in the one queue process (no stray background sleepers, record PID, stop only that PID); fail-safe default stays "stop", never "continue".
- Commands: cd loki-ts && bun test quota_cap queue_resume; bash tests/test-queue-consumer.sh; tsc.
- Flag: LOKI_QUOTA_CAP=1 initially, flipped default-on in a follow-up after one clean week (founder asked default on; the flip is a one-line change in the same slice if reviewers approve). Tier HIGH.

## Program 7: VERIFY-PR

Ground truth: `loki verify` (engine10/verify_cmd.ts) verifies a receipt, not a PR; `.github/actions/receipt-check` posts a "Loki Receipt" check run from `check.sh`; the project model (loki-ts/src/project_model/{discover,package_suite,scope}.ts) discovers packages and per-package test suites; `util/safe_git.ts` is the hardened-git path (fsmonitor, hooks, ext:: off, tokens stripped); `util/redact.ts` exists. There is NO fail-to-pass concept in the engine (grep f2p: 0), no PR-checkout verify path, and no sandbox runner under loki-ts/src/runner other than what run.sh uses. The report's "F2P test" must be defined here: the checks derived from the linked issue (engine10/fetch_issue.ts, features/contract.ts) must FAIL on the PR base and PASS on the PR head. Untrusted code: Rule of Two means this job may combine at most two of {untrusted input, secrets/tokens, outbound write}. Design: the verify job gets untrusted input (the PR code) and NO token and NO network; a second job with no untrusted code (reads only the result artifact) holds `checks: write`, signs, and posts.

### VPR-1 Sandbox spec and runner contract (HIGH, 30 min plus pair review)
- Goal: a runner script that executes derived checks against a PR checkout inside a container with: no network (`--network none` after deps are pre-installed from a lockfile-pinned cache or skipped with NOT PROVEN), read-only root, tmpfs workdir, non-root, CPU/mem/pids caps, wall timeout, env scrubbed with `tokenFreeEnv`, no mounted docker socket or HOME. Outputs only a JSON result file via a single mounted output dir.
- File set: scripts/verify-pr-sandbox.sh (new), docs/v11/VERIFY-PR-SANDBOX.md (threat model: malicious package.json scripts, git hooks, symlinks out of the repo, oversized output, fork bombs), tests/test-verify-pr-sandbox.sh (new, uses a hostile fixture repo).
- Tests first, hostile fixture: a test script that tries to curl, read $HOME, write outside the workdir, read GH_TOKEN, spawn 10k procs, and fill the disk; each attempt must fail or be capped and the result file must say so. If docker is absent the test SKIPs loudly with a positive control (memory: 0/N needs a positive control).
- Wall: never `git checkout` with repo hooks enabled (use safe_git); never kill by name or pattern; docker usage per memory (pool exhaustion looks like a product bug: detect and report as BLOCKED, not as a failing verdict).
- Commands: bash tests/test-verify-pr-sandbox.sh; shellcheck scripts/verify-pr-sandbox.sh. Flag: none (script, unused until VPR-2). Tier HIGH.

### VPR-2 `loki verify-pr <url>` core (HIGH, 30 min plus pair review; after VPR-1)
- Goal: parse a PR URL or owner/repo#N; fetch metadata and linked issue via gh with a read-only token; fetch base and head with safe_git; derive the delivery contract from the linked issue (reuse features/contract.ts and pr_criteria.ts); run Project Model checks for the touched packages (project_model/scope.ts); run the F2P check as defined above through the VPR-1 sandbox; write `verify-pr-result.json` with a verdict from the existing outcome set (VERIFIED, NOT PROVEN with reasons) and exit codes aligned with `loki verify`. No linked issue means NOT PROVEN with reason, never VERIFIED. Verdict can only be VERIFIED if F2P went red-to-green AND package suites passed.
- File set: loki-ts/src/commands/verify_pr.ts (new), loki-ts/src/engine10/verify_pr_f2p.ts (new), registration in cli.ts, autonomy/loki dispatch, completion.ts, loki-ts/test/verify_pr.test.ts with a local bare-repo fixture (no network).
- Tests first: fixture PR whose fix is real gives VERIFIED; a PR that deletes the failing test gives NOT PROVEN (test removed); a PR where the check passes on base too gives NOT PROVEN (check does not discriminate); hostile PR script cannot reach network (uses VPR-1); missing linked issue; forged "tests pass" in PR body ignored.
- Wall: the verdict logic is a new Seal-class path, reviewers must run a mutation (flip the base/head order and see red); no model call in this slice, checks are the author's own.
- Commands: cd loki-ts && bun test verify_pr; tsc; bash tests/test-completion*.sh. Flag: LOKI_VERIFY_PR=1 until reviewed. Tier HIGH.

### VPR-3 Signed receipt and check run job split (HIGH, 30 min plus pair review; after VPR-2)
- Goal: GitHub Action `.github/actions/verify-pr` with two jobs documented as a reusable workflow: job A (untrusted, `permissions: {}`, no secrets, runs VPR-2 and uploads the result artifact), job B (trusted, runs no PR code, `checks: write`, downloads only the JSON, validates it against a strict schema, signs with the receipt key from secrets or Sigstore keyless, and posts the check run by reusing `.github/actions/receipt-check/check.sh`). `pull_request_target` is forbidden in the examples.
- File set: .github/actions/verify-pr/action.yml (new), .github/workflows/verify-pr.example.yml (new), docs/v11/VERIFY-PR-SANDBOX.md (job split section), tests/test-verify-pr-action-split.sh (YAML assertions).
- Tests first: job A has no secrets/token and no write permission; job B never checks out PR code; no `pull_request_target`; the artifact schema rejects extra fields and over-size input; check summary is truncated and redacted.
- Wall: Rule of Two (never all three of untrusted code, token, write in one job).
- Commands: bash tests/test-verify-pr-action-split.sh. Flag: Action input only. Tier HIGH.

## Program 8: FALSE-COMPLETION-RATE

Ground truth: `scripts/b9-scoreboard.sh` today has four arms (raw `claude -p`, router, no-router, no-advisor) and records `solve` (hidden tests) per run; the `--ab` flag and the raw/loki arms with cost, correctness, wall ratios live on branch slice-B9-RAW-ARM (tip 28d9ddf89, not on main as of this card; commits 1ae2fd914, c53882b40, 28d9ddf89). There is no raw codex arm and no "claimed done" capture anywhere. METRICS is docs/v10/METRICS.md. Do not start until slice-B9-RAW-ARM merges (check `git branch --contains 28d9ddf89`).

### FCR-1 Claimed-done extraction (MEDIUM, 30 min; after B9-RAW-ARM merge)
- Goal: a function classifying each arm's final output as `claimed_done` (true/false/unclear) deterministically: raw arms by an explicit last-line contract appended to the prompt ("end with DONE or BLOCKED"), loki arm by its receipt outcome (VERIFIED counts as claimed done, NOT PROVEN does not).
- File set: scripts/b9-claim.py (new, stdlib), tests/test-b9-claim.sh, fixtures under tests/fixtures/b9-claim/.
- Tests first: fixtures for DONE, BLOCKED, missing marker (unclear, excluded and counted), a lying DONE with failing hidden tests; loki NOT PROVEN is not a claim.
- Wall: no model call to classify (a model judge would be a second unreliable measurer); script is pure.
- Commands: bash tests/test-b9-claim.sh. Flag: none. Tier MEDIUM.

### FCR-2 Raw codex arm and public task set (MEDIUM, 30 min; after FCR-1)
- Goal: add `raw-codex` arm beside raw-claude; define the public task set as pinned repo+SHA+hidden test command rows in docs/v11/FCR-TASKS.tsv (at least 20, license-compatible, reproducible by anyone with the CLIs); `--dry-run` uses the existing stub CLIs.
- File set: scripts/b9-scoreboard.sh (arm only), docs/v11/FCR-TASKS.tsv, tests/test-b9-scoreboard.sh (extend).
- Tests first: dry-run produces one row per arm per task; codex arm preflight failure is BLOCKED not a fail (existing BLOCKED rule); a timed-out cell is recorded, not dropped (memory: bench timeout silent cell loss).
- Wall: a 0/N for an arm needs a positive control row; shellcheck; no billed run in CI.
- Commands: bash tests/test-b9-scoreboard.sh. Flag: --arms selector. Tier MEDIUM.

### FCR-3 False-completion column and METRICS row (MEDIUM, 30 min; after FCR-2)
- Goal: `--fcr` prints, per arm, `claimed_done`, `actually_passes`, `false_completion_rate = claimed_done_and_failing / claimed_done` with n and a Wilson interval, appended as a labelled row in docs/v10/METRICS.md only from real (non-dry) runs.
- File set: scripts/b9-scoreboard.sh (reporting), docs/v10/METRICS.md (row format, no numbers invented), tests/test-b9-scoreboard.sh.
- Tests first: fixture TSV gives the exact rate and interval; n below 20 prints "insufficient n" instead of a rate; dry-run rows are tagged and refused by the METRICS writer.
- Wall: any published number cites the TSV, commands and run date (evidence rule); design floor check (memory) so small n never claims separation.
- Commands: bash tests/test-b9-scoreboard.sh. Flag: --fcr. Tier MEDIUM.

## Program 9: UNDO

Ground truth: `loki rollback` (loki-ts/src/commands/rollback.ts) restores `.loki/` state checkpoints (runner/checkpoint.ts), NOT git commits; there is no `loki undo` (grep: none). The receipt has `base_sha`, `head_sha` (seal.ts:304-305); commits carry `Loki-Run: <id>` (seal.ts:138); engine10 `ctx.branch` is the branch; PR creation is in stages/pr.ts (`pr_url` in outputs). Git must go through util/safe_git.ts.

### UNDO-1 Plan builder (read-only) (MEDIUM, 30 min)
- Goal: `loki undo <run-id> --plan` verifies the receipt first (reuse verify_cmd logic, refuses TAMPERED), then lists exactly the commits in base_sha..head_sha that carry that run's `Loki-Run` trailer, the branch, the PR url if any, and whether each commit is already on the default branch, pushed, or merged. Prints what undo would do. Changes nothing.
- File set: loki-ts/src/commands/undo.ts (new, plan only), cli.ts + autonomy/loki dispatch + completion.ts registration, loki-ts/test/undo_plan.test.ts (temp git repo fixture).
- Tests first: unmerged branch plan = delete branch; merged plan = revert commits; commit from another run in the range is excluded; tampered receipt refused; unknown run exits 66.
- Wall: zero writes in this slice (assert repo HEAD/refs unchanged); new-command registration guards.
- Commands: cd loki-ts && bun test undo_plan; tsc. Flag: none. Tier MEDIUM.

### UNDO-2 Apply: revert or drop, with confirmation (HIGH, 30 min plus pair review; after UNDO-1)
- Goal: `loki undo <run-id>` executes the plan: local unmerged branch is deleted after confirmation; already-merged commits are reverted with `git revert --no-edit` on a new branch (never rewrite history, never force-push); closes the PR via gh only with `--close-pr`; a pre-undo ref is recorded so undo itself is undoable; `--yes` skips the prompt but never skips the receipt check. Reason HIGH: destructive and receipt-dependent.
- File set: loki-ts/src/commands/undo.ts, loki-ts/src/util/safe_git.ts (read only unless a revert wrapper is missing), loki-ts/test/undo_apply.test.ts.
- Tests first: revert leaves a clean tree and the revert restores base tree hash; branch with later foreign commits is refused with a message; dirty worktree refused; no force flags appear in any recorded git argv (assert on the injected runner); success and failure both write `.loki/undo/<run>.json`.
- Wall: never touches the user's current branch unless it is the run branch; no `reset --hard`; tokens only for the gh close step.
- Commands: cd loki-ts && bun test undo_plan undo_apply; tsc. Flag: LOKI_UNDO=1 until reviewed. Tier HIGH.

## Program 10: MEMORY-CITES

Ground truth: T6 memory with proof v1 is `loki-ts/src/util/pr_lessons.ts` (store `.loki/memory/semantic/pr-lessons.json`; each lesson has source {pr, pr_url, comment_url, kind, author} and `uses` [{run_id, verdict, at}]) driven by `loki memory lessons` (commands/memory.ts). It already refuses non-merged PRs (pr_lessons.ts:84 `is not merged`). So "cites its receipt" is half built: `uses` carries run_id and verdict of runs that used a lesson, but a lesson does not cite the receipt (run) that justified creating it, and nothing learns from closed-unmerged PRs. 132-F3 in docs/v10/BACKLOG-D91.md ("lesson hit rate and demotion") touches the same file: sequence after it.

### MC-1 Lesson cites the receipt of the PR's run (MEDIUM, 30 min; after 132-F3)
- Goal: when a lesson is learned from a PR whose branch/commits carry a `Loki-Run` trailer (or the PR body receipt link from MARK-1), store `justified_by: {run_id, receipt_sha256, verdict}`; lessons from non-Loki PRs have none and show "no receipt". `loki memory lessons` prints the citation.
- File set: loki-ts/src/util/pr_lessons.ts, loki-ts/src/commands/memory.ts, loki-ts/test/pr_lessons.test.ts (extend).
- Tests first: injected GhClient returns commits with trailer, so the lesson carries the cite; receipt hash comes from the local receipt file only if it exists and verifies, else `unverified`; file version bumps to 2 with a v1 reader test (old files still load).
- Wall: lesson text still verbatim; atomic write via util/atomic.ts; no change to prompt injection yet.
- Commands: cd loki-ts && bun test pr_lessons; tsc. Flag: none. Tier MEDIUM.

### MC-2 Learn from closed-unmerged PRs (MEDIUM, 30 min; after MC-1)
- Goal: `loki memory lessons learn <pr>` accepts a PR closed without merge when it was a Loki PR (trailer present): records the review comments and the close event as lessons with `kind: "rejected"` and the PR's run id, so the planner prompt can show "a previous attempt on this repo was rejected for: ...". Non-Loki closed PRs and PRs with no human comments are skipped with a stated reason.
- File set: loki-ts/src/util/pr_lessons.ts (relax the merged guard behind a kind), loki-ts/src/commands/memory.ts, loki-ts/test/pr_lessons.test.ts.
- Tests first: closed-unmerged with comments yields rejected-kind lessons; merged PR path unchanged (regression); closed with zero comments yields none and says why; bot comments filtered the same way as today.
- Wall: lessons are data, never instructions: prompt injection use must keep the existing lesson quoting boundary (read how learnings are injected before changing; any prompt text goes in the cache-stable prefix per repo invariant).
- Commands: cd loki-ts && bun test pr_lessons. Flag: LOKI_LESSONS_REJECTED=1. Tier MEDIUM.

## Program 11: CROSS-VENDOR-JUDGE

Ground truth: B4 is `loki-ts/src/engine10/stages/xreview.ts`: opt-in only, `reviewProvider()` returns the provider from LOKI_REVIEW_PROVIDER or loki.yaml `review:`, else null (off); `minVerdict` can only downgrade; providers limited to "codex" | "claude" (ReviewProvider type); `ctx.provider` is the builder. There is no auto-selection and no "different from builder" rule, and the review can be set equal to the builder today. Gemini is deprecated (do not add it).

### XV-1 Default to a different vendor when one is installed (MEDIUM, 30 min)
- Goal: when no explicit `review:` is set, `reviewProvider` returns the other vendor than `ctx.provider` if its CLI is on PATH and authenticated (reuse the preflight check in engine10/preflight.ts), else null (unchanged, off). Explicit setting always wins, including explicit `off`. Receipt records `review.provider`, `review.vendor_differs: true|false`, and when no other vendor is configured a NOT PROVEN line "judge shares builder vendor or none configured".
- File set: loki-ts/src/engine10/stages/xreview.ts (selection function only), loki-ts/src/engine10/stages/seal.ts (receipt field and NOT PROVEN line only; this edit touches the Seal receipt body, so tier is HIGH, see below), loki-ts/test/xreview.test.ts.
- Tests first: builder claude + codex available gives codex; builder codex + claude available gives claude; only one vendor gives null plus the NOT PROVEN line; explicit review: claude with builder claude is honored and flagged vendor_differs false; the verdict can still only be downgraded (existing minVerdict test stays green).
- Wall: never upgrade a verdict; reviewer argv stays read-only (reviewArgv untouched); fail-safe default unchanged (judge unavailable means not_run, not pass).
- Commands: cd loki-ts && bun test xreview seal; tsc.
- Flag: LOKI_XVENDOR_DEFAULT=1 (default on after review; the existing opt-in behaviour is the OFF state). Tier HIGH (touches seal.ts receipt body).

# Index (id, tier, estimated minutes, flag)

| ID | Tier | Min | Flag | Depends on |
|---|---|---|---|---|
| MCP-0 | LOW | 15 | none | none |
| MCP-A | MEDIUM | 30 | none | none |
| MCP-B | LOW | 15 | none | MCP-0 optional |
| MCP-C | MEDIUM | 30 | LOKI_MCP_2026_07 | MCP-0, MCP-A |
| MCP-D | HIGH | 30+review | LOKI_MCP_TASKS | MCP-C, OTEL-1 |
| OTEL-1 | MEDIUM | 30 | LOKI_OTEL_GENAI | none |
| OTEL-2 | HIGH | 30+review | via OTEL-1 | OTEL-1 |
| SARIF-1 | LOW | 15 | none | none |
| SARIF-2 | MEDIUM | 30 | none | SARIF-1 |
| SARIF-3 | MEDIUM | 30 | action input | SARIF-2 |
| SIGS-1 | HIGH | 30+review | --predicate slsa | none |
| SIGS-2 | HIGH | 30+review | action input | SIGS-1 |
| SIGS-DOC | LOW | 15 | none | none |
| MARK-1 | HIGH | 30+review | LOKI_AI_MARKING | none |
| MARK-2 | MEDIUM | 30 | none | none |
| MARK-3 | MEDIUM | 30 | none | MARK-1, MARK-2 |
| QF-1 | LOW | 15 | none | none |
| QF-2 | MEDIUM | 30 | LOKI_FORECAST | QF-1 |
| QF-3 | HIGH | 30+review | LOKI_QUOTA_CAP | QF-2 |
| VPR-1 | HIGH | 30+review | none | none |
| VPR-2 | HIGH | 30+review | LOKI_VERIFY_PR | VPR-1 |
| VPR-3 | HIGH | 30+review | action input | VPR-2 |
| FCR-1 | MEDIUM | 30 | none | B9-RAW-ARM merged |
| FCR-2 | MEDIUM | 30 | --arms | FCR-1 |
| FCR-3 | MEDIUM | 30 | --fcr | FCR-2 |
| UNDO-1 | MEDIUM | 30 | none | none |
| UNDO-2 | HIGH | 30+review | LOKI_UNDO | UNDO-1 |
| MC-1 | MEDIUM | 30 | none | 132-F3 |
| MC-2 | MEDIUM | 30 | LOKI_LESSONS_REJECTED | MC-1 |
| XV-1 | HIGH | 30+review | LOKI_XVENDOR_DEFAULT | none |
