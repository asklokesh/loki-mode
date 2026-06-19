# Unified Config-File Plan (FEAT-CONFIG, task #691)

Status: design for implementation. Build target: POST-v7.73.0 main (the v7.73.0
branch-default + `loki deploy` + secret-scan work is present in the working tree;
all line anchors below are verified against that state). NO version bump, NO
commit, NO implementation code in this doc. Devil's-advocate corrections to the
approved plan (`~/.claude/plans/polished-waddling-stardust.md`) are folded in and
marked CORRECTION where the approved text was factually wrong against source.

Goal: `loki start --config <path>` (aliases `--vars`, `--env-file`) loads a single
`.env` / YAML / JSON file so Docker / compose / k8s / Vault operators inject one
mounted file instead of a wall of `LOKI_*` env vars or CLI flags. v1 makes ALL
~250 flags configurable via flat `.env`; nested friendly YAML/JSON full-coverage
is v2. Secrets are never inlined -- referenced via `${VAR}`.

--------------------------------------------------------------------------------
## 0. Locked precedence ladder (CONTRACT -- cannot be phased)

```
CLI flags          (explicit this run)                         highest
  > --config file  (explicit this run)                         <- NEW layer
  > ambient env    (ConfigMap / Secret / .env_file / exported LOKI_*)
  > auto .loki/config.yaml + ~/.config/loki-mode/config.yaml   (ambient project file)
  > settings.json  (.loki/config/settings.json)
  > built-in defaults                                          lowest
```

`--config` MUST beat ambient env: the Helm chart injects every non-secret `LOKI_*`
via `envFrom: configMapRef` and docker-compose auto-loads `.env`, so ambient
`LOKI_*` is ALWAYS present in the exact deployments this feature targets. If env
beat `--config`, a mounted file would override nothing. Auto-discovered
`.loki/config.yaml` stays env-LOSES (unchanged contract).

--------------------------------------------------------------------------------
## 1. Pre-pass placement in main() (autonomy/loki)

Verified anchors: `main()` at loki:15285; `command="$1"; shift` at 15301-15302;
`loki_telemetry` at 15307; `case "$command"` dispatch at 15309 (`start)` ->
cmd_start at 15314, `run)`/`quick)` adjacent). cmd_start at loki:1012, its arg
loop at 1042. Exec handoff `_loki_new_session_exec "$RUN_SH" ...` at loki:2097.
CLI flags export inline in the cmd_start loop (e.g. `export LOKI_COMPLEXITY=simple`
under `--simple`; `export LOKI_GITHUB_IMPORT=true` under `--github`), confirmed in
the 1042-1560 range.

### 1a. Where the pre-pass runs
Insert the pre-pass AFTER `command="$1"; shift` (15302) and AFTER the
`loki_telemetry` call (15307), and BEFORE the `case "$command"` dispatch (15309).
Gate it to SESSION commands only so `loki status` / `config` / `stop` etc. never
trigger a config load:

```
case "$command" in
    start|run|quick)
        loki_maybe_apply_config_file "$@"   # NEW pre-pass; scans, does NOT consume
        ;;
esac
# ... existing case "$command" dispatch unchanged ...
```

`loki_maybe_apply_config_file` is a NEW helper sourced from the new lib (SS2). It:
1. Honors `LOKI_CONFIG_FILE` env var first (for ENTRYPOINT / in-container direct
   `loki start` where flags are awkward). An explicit flag overrides the env var.
2. Pre-SCANS `"$@"` for `--config[=]`, `--vars[=]`, `--env-file[=]` to extract the
   path, WITHOUT shifting/consuming (the per-command loops still see every arg).
   Scan reads both `--config <path>` and `--config=<path>` forms.
3. If a path is found, calls `loki_apply_config_file "$path"` (SS2), which detects
   format, expands `${VAR}` refs, validates, and `export LOKI_*` for each key.

### 1b. Why pre-pass (not a run.sh flag)
By the time run.sh runs, a config-set `LOKI_COMPLEXITY=simple` is byte-identical to
an ambient env var; run.sh cannot tell explicit-config from ambient env. Only a
pre-pass running BEFORE the cmd_start arg loop can:
- (a) be OVERWRITTEN by the subsequent CLI loop -> CLI > config, no extra logic
  (the loop's own `export LOKI_*=...` arms run after and win); and
- (b) have its exports SURVIVE `exec run.sh` (loki:2097), where auto-config /
  settings.json / defaults all env-LOSE to what is already set.

The pre-pass export OVERRIDES ambient env -- the ONE intentional difference from
the existing env-wins loaders, correct per the Helm/compose reasoning. DO NOT add
a "force-override from explicit config" path to run.sh's env-wins guard
(run.sh:395/490): it would clobber CLI flags and break CLI > config.

### 1c. REQUIRED cmd_start edit (do not let this hide in "scan without consume")
Because the pre-pass does NOT consume args, cmd_start's loop (1042+) still SEES
`--config <path>`. With no case arm it would be misread as the PRD positional or
forwarded to run.sh. ADD consume-and-ignore arms in the cmd_start arg loop (and in
cmd_run / cmd_quick loops if they accept these) for all three aliases, both `=`
and space forms:

```
--config|--vars|--env-file)        shift 2; continue ;;   # consumed by pre-pass
--config=*|--vars=*|--env-file=*)   shift;   continue ;;
```

These arms intentionally do nothing else: the pre-pass already applied the file.

--------------------------------------------------------------------------------
## 2. NEW autonomy/lib/config-map.sh (single-source mapping; fixes the 3-way drift)

This lib is the canonical mapping array PLUS the config-file loader helpers, and
it is the SINGLE HOME of the parse-and-export logic. It is sourced by BOTH the loki
pre-pass and run.sh's parsers, collapsing 3 tables to 1.

DESIGN CONSTRAINT (for SDET, SS7): the lib MUST be SIDE-EFFECT-FREE ON SOURCE --
sourcing it only defines the array + functions, exports nothing, runs nothing. The
loki pre-pass and run.sh each call the functions explicitly. This lets unit tests
source the lib and call individual functions (parser, expander) in isolation.

### 2a-0. The override-mode loader (the load-bearing precedence mechanism)
The keystone (config beats ambient env) lives HERE, as an `override` PARAMETER on
the shared per-key export -- NOT in run.sh, NOT duplicated per format. All three
format parsers (.env / YAML / JSON) call ONE export helper:

```
loki_config_export_key <env_var> <value> <override>
   # if [ "$override" != 1 ] && [ -n "${!env_var:-}" ]; then return 0; fi   # env-wins guard
   # value -> ${VAR}-expand -> validate_yaml_value -> export
```

- loki pre-pass (SS1) calls every key with override=1  -> config BEATS ambient env,
  UNIFORMLY across .env / YAML / JSON (this is what makes case 3 AND case 7 pass).
- run.sh's two parsers (SS3) delegate with override=0 -> env-wins guard PRESERVED,
  the existing auto-discovery contract is byte-unchanged.

CORRECTION (defect in the first draft): do NOT have the pre-pass "reuse run.sh
engines" by sourcing run.sh -- run.sh fires on-source side effects
(load_config_file at run.sh:507, _load_json_settings at 567, all the `:-` defaults).
The pre-pass sources config-map.sh ONLY and calls its loader; run.sh ALSO sources
config-map.sh and calls the same loader with override=0. Without the override
parameter, a reused env-wins parser would SKIP a config key whenever ambient env is
present -- exactly the Helm/compose case -- so the keystone would silently fail for
YAML/JSON while .env (no guard) overrode correctly, diverging the formats.

### 2a. Canonical array

```
LOKI_CONFIG_MAP=(
  "nested.path:LOKI_ENV_VAR"
  ...
)
```

### 2b. VERIFIED drift enumeration (CORRECTIONS to the approved plan)

Three tables exist today:
- T1 `parse_simple_yaml` (run.sh:262-350) -- 64 `set_from_yaml` calls.
- T2 `parse_yaml_with_yq` (run.sh:419-504) -- 61 `path:LOKI_*` entries.
- T3 `config.example.yaml` (docs the user-facing keys).

Verified deltas (read against source, not the approved plan's claims):

1. `model.planning`, `model.development`, `model.fast` -> in T1 (run.sh:320-322)
   ONLY; ABSENT from T2 and from T3. (Approved plan correct.) Target env vars
   LOKI_MODEL_PLANNING / _DEVELOPMENT / _FAST are CONFIRMED via settings.json
   mapping (run.sh:546-548). T1 minus T2 = exactly these 3 (64 vs 61).

2. `model.compaction_interval` -> in T3 (config.example.yaml:120) ONLY; NOT in T1,
   NOT in T2. CORRECTION/IMPORTANT: it has ZERO runtime consumer anywhere
   (`grep compaction_interval|LOKI_COMPACTION` -> nothing). It is a DEAD documented
   key. Do NOT invent a LOKI_* var for it in v1. Either (a) wire a real consumer
   first, or (b) drop it from the generated example. Recommended v1: leave it OUT
   of LOKI_CONFIG_MAP and remove it from the generated example (note in CHANGELOG),
   defer a real consumer to v2.

3. `model.autonomy_mode` -> CORRECTION: the approved plan says "neither table
   carries" it. FALSE. It is in T1 (run.sh:319), T2 (run.sh:463) AND T3
   (config.example.yaml:118). It is fully consistent; do not treat it as drift.

4. `completion.council.*` (6 keys: enabled/size/threshold/check_interval/
   min_iterations/stagnation_limit) and `completion.uncertainty.*` (4 keys:
   escalation/rounds/nochange_min/split_rounds) -> in BOTH T1 and T2, but ABSENT
   as live keys from T3 (council not present; uncertainty only as commented prose
   at example.yaml:92-107). So T3 (config.example.yaml) is the MOST out-of-sync of
   the three. The generated `config example` (SS6) closes this by emitting these
   from LOKI_CONFIG_MAP so example can never lag the parsers again.

### 2c. Reconciled canonical key set (LOCK)

LOKI_CONFIG_MAP = the 64 keys of T1 (the superset; it equals T2's 61 PLUS the 3
model.* keys). `model.compaction_interval` is EXCLUDED (no consumer). Final v1
count: 64 mappings. They are (grouped):

- core: max_retries, base_wait, max_wait, skip_prereqs
- dashboard: enabled, port
- resources: check_interval, cpu_threshold, mem_threshold
- security: staged_autonomy, audit_log, max_parallel_agents, sandbox_mode,
  allowed_paths, blocked_commands
- phases: unit_tests, api_tests, e2e_tests, security, integration, code_review,
  web_research, performance, accessibility, regression, uat
- completion: promise, max_iterations, perpetual_mode
- completion.council: enabled, size, threshold, check_interval, min_iterations,
  stagnation_limit
- completion.uncertainty: escalation, rounds, nochange_min, split_rounds
- model: prompt_repetition, confidence_routing, autonomy_mode, planning,
  development, fast
- parallel: enabled, max_worktrees, max_sessions, testing, docs, blog, auto_merge
- complexity: tier
- github: import, pr, sync, repo, labels, milestone, assignee, limit, pr_label
- notifications: enabled, sound

The exact `nested.path:LOKI_ENV_VAR` pairs are copied verbatim from T1's
`set_from_yaml` calls (run.sh:266-349) so env-var names are guaranteed correct.

### 2d. settings.json mapping stays SEPARATE (do not merge)
`_load_json_settings` (run.sh:544-558) carries a DIFFERENT schema -- maxTier,
provider, issue.provider, notify.slack/discord, blind_validation,
adversarial_testing, spawn_timeout, spawn_retries, budget -- none of which any YAML
parser maps. Only model.planning/development/fast overlap. LOKI_CONFIG_MAP is the
YAML/config-file surface ONLY; settings.json keeps its own map. Merging them would
corrupt both surfaces. (v2 may optionally unify, additively.)

--------------------------------------------------------------------------------
## 3. Refactor run.sh's two parsers to iterate the shared array

After config-map.sh exists, both parsers source it and iterate LOKI_CONFIG_MAP,
delegating the per-key export to the shared loader with override=0 (env-wins
PRESERVED -- the auto-discovery contract is unchanged):

- `parse_yaml_with_yq` (run.sh:419-504): delete the inline `mappings=(...)` array
  (421-483); source config-map.sh; loop over `LOKI_CONFIG_MAP`; for each key read
  the value via `yq eval ".$path"` (as today, 496) and pass it to
  `loki_config_export_key "$env_var" "$value" 0`. The shared helper now owns the
  env-wins guard, validate, and export (formerly run.sh:490-501).
- `parse_simple_yaml` (run.sh:262-350): replace the 64 hand-written
  `set_from_yaml` calls with a loop over LOKI_CONFIG_MAP. `set_from_yaml`
  (run.sh:389) is refactored to extract via grep/sed (410) then delegate to
  `loki_config_export_key "$env" "$value" 0` (so its guard/validate/export at
  395/413/414 also route through the single shared helper).

`load_config_file` (run.sh:228-259) and its yq-present/absent routing are
unchanged. Net effect: 3 tables -> 1 AND one export helper -> env-wins (override=0)
and config-override (override=1) share identical parse/validate logic, so .env /
YAML / JSON can never diverge. run.sh keeps override=0 everywhere, so its shipped
behavior is byte-identical.

--------------------------------------------------------------------------------
## 4. Format detection + parsing (reuse existing engines)

`loki_apply_config_file <path>` (in config-map.sh):

1. Validate path: file exists, readable, not a symlink for project-local paths
   (mirror load_config_file's symlink guard at run.sh:234). Missing/unreadable ->
   honest non-zero exit + message; NO silent default fallback.
2. Detect format:
   - extension `.env` / no-ext-named-".env" -> ENV
   - `.yaml` / `.yml` -> YAML
   - `.json` -> JSON
   - unknown/no extension -> content sniff: first non-blank, non-`#` line
     starts with `{` -> JSON; matches `^[A-Z_][A-Z0-9_]*=` -> ENV; matches
     `^[a-zA-Z0-9_.-]+:` -> YAML.
3. Route (ALL three call `loki_config_export_key ... 1` -- override=1, in
   config-map.sh; the pre-pass sources config-map.sh ONLY, never run.sh):
   - ENV -> flat parser (SS4a).
   - YAML -> yq if `command -v yq` else the simple grep/sed fallback, iterating
     LOKI_CONFIG_MAP over the arbitrary path. Same logic as run.sh's parsers but
     invoked with override=1.
   - JSON -> yq reads JSON natively; else the audited python3 path modeled on
     `_load_json_settings` (run.sh:525-565): json.load, isinstance(str) guard,
     shlex.quote, fixed export template. Reuse that exact safe pattern, then feed
     each resolved value to `loki_config_export_key ... 1`.

### 4a. The flat `.env` parser (FULL ~250-flag coverage, day one)

For each line: skip blank and `#`-comment lines; split on the FIRST `=` only
(`key="${line%%=*}"`, `val="${line#*=}"`); strip surrounding quotes; trim. Key
allowlist: accept `^LOKI_[A-Z0-9_]+$`. Also accept a SHORT documented allowlist of
non-LOKI build vars actually consumed (verify each against source before locking;
candidates seen in run.sh defaults: e.g. provider/budget are already LOKI_*).
Default: reject any key not matching the allowlist with a visible warning (never a
silent skip). Each accepted value goes through `${VAR}` expansion (SS5) THEN
`validate_yaml_value` (run.sh:353) THEN `export`. This is what makes "all flags
configurable" honest on day one with near-zero code -- `.env` is the flat
full-surface form; nested friendly YAML/JSON full-coverage is v2.

Every value (ENV/YAML/JSON) passes `validate_yaml_value` (run.sh:353) before
export: rejects shell metachars `[$\`|;&><(){}[]\\]`, newlines, over-length
(>1000). NOTE (document this): because validate runs AFTER expansion, a resolved
secret whose VALUE contains a shell metachar would be rejected. This is
conservative and acceptable -- such values must be delivered via the env directly,
not through the validated config path.

--------------------------------------------------------------------------------
## 5. ${VAR} env-ref expansion + raw-secret warning

### 5a. Expansion (NEVER eval)
- Match a full-value ref `^\$\{[A-Za-z_][A-Za-z0-9_]*\}$` and embedded refs.
- Resolve via bash indirect expansion: `name="${ref:2:-1}"; value="${!name}"`.
  NEVER `eval`.
- Order is EXPAND-THEN-VALIDATE: validate_yaml_value rejects `$`, so an
  unexpanded `${VAR}` would always fail. Expansion is precisely what makes a ref
  usable while every other literal `$` stays rejected.
- Unset ref -> SKIP that key + emit a warning (do not export empty, do not abort
  the whole load). `config validate` reports unresolved refs (SS6).

### 5b. Raw-secret warning (reuse the shipped scanner patterns)
Reuse the verified v7.73.0 commit-time scanner ideas:
`autonomy/run.sh:_commit_scan_secret_file` (6331-6382) and
`_commit_path_looks_secret` (6384+), which mirror `autonomy/verify.sh`'s
`verify_secret_scan_file`. Apply its TIER-1 format patterns to a config-file
VALUE that is a literal (not a `${VAR}` ref):

```
AKIA[0-9A-Z]{16} | ASIA[0-9A-Z]{16}
-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----
gh[pousr]_[A-Za-z0-9]{36,} | github_pat_[A-Za-z0-9_]{60,}
xox[baprs]-[A-Za-z0-9-]{10,}
sk-[A-Za-z0-9]{20,}   (covers sk-ant-)
AIza[0-9A-Za-z_-]{35} | glpat-[A-Za-z0-9_-]{20,}
```

Plus TIER-2 generic-assignment + bearer + URI-embedded-credential
(`scheme://user:pass@host`) patterns, run through the existing deny filter so
`${VAR}`-ref values are correctly IGNORED (the deny regex already excludes
`\$\{`/`\$[A-Za-z_]`/`process.env`/placeholders). On load: WARN ("use ${VAR} +
env/Vault"). In `config validate`: ERROR (non-zero exit).

--------------------------------------------------------------------------------
## 6. `loki config example|schema|validate` (reuse loki:8177-8244 validators)

### 6a. CRITICAL prerequisite: extract the validators
The per-key validators at loki:8177-8244 are INLINE in `cmd_config_set` (8141),
not a reusable function. CORRECTION to "reuse loki:8177-8244 validators": they
cannot be reused as-is. EXTRACT them into a new `validate_config_key <key>
<value>` helper (returns non-zero + message on invalid), and have BOTH
cmd_config_set AND `config validate` call it. Otherwise we duplicate the
validator logic -- reintroducing the exact drift this feature exists to fix.

### 6b. New subcommands (add arms to cmd_config dispatch, loki:8093-8137)
- `config example` -> emit the full annotated nested YAML GENERATED from
  LOKI_CONFIG_MAP (so it can never drift from the parsers), carrying
  config.example.yaml's prose as comments. Drop the dead `compaction_interval`.
- `config schema` -> machine-readable `key -> LOKI_ENV_VAR -> type` table,
  generated from LOKI_CONFIG_MAP.
- `config validate <file>` -> detect format (SS4), dry-expand refs and report
  unresolved (SS5a), raw-secret check as ERROR (SS5b), run `validate_config_key`
  per key where a validator exists, run `validate_yaml_value` on every value.
  Non-zero exit on ANY failure. Update the cmd_config usage block (8113-8136) and
  the `*)` default help to list the three new subcommands.

--------------------------------------------------------------------------------
## 7. SDET test plan (mutation-proof; the 12 cases)

OBSERVABILITY DESIGN (this is the hard part -- named, not hand-waved):
- config-map.sh is side-effect-free on source (SS2), so the .env parser, the
  `${VAR}` expander, format-detect, and the raw-secret matcher are UNIT-tested by
  sourcing the lib and calling each function directly with crafted input.
- For the integration cases (esp. the keystone) the test drives the REAL binary
  as a subprocess (same rationale as test-deploy.sh's header: autonomy/loki runs
  main() when sourced, so extract+source is unsafe). The test needs an OBSERVATION
  HOOK to read the RESOLVED `LOKI_*` without a full build. Mechanism: stub the
  exec target -- put a fake `run.sh` (or a fake provider CLI) earlier on PATH /
  via a test-only `RUN_SH` override that DUMPS the environment (`env | grep ^LOKI_`)
  to a sentinel file and exits 0. The test asserts on the dumped values. (A small
  documented `LOKI_CONFIG_DUMP=1` dry mode that prints resolved LOKI_* and exits
  is an acceptable alternative observation hook; pick one and document it.)
- The test MUST NOT set `LOKI_AUTO_FIX=true`: run.sh:625-627 would clobber
  MAX_ITERATIONS to 5 and corrupt the MAX_ITERATIONS assertions.
- Non-vacuity: every "value reaches runtime == X" assertion is paired with a flip
  to a second value to prove it is not a default coincidence.

Cases:
1. Config-only key reaches runtime: `LOKI_MAX_ITERATIONS=4242` via config file
   only -> dumped == 4242; flip to 1337 to prove non-default.
2. CLI overrides config: config `complexity.tier: complex` + `--simple` -> simple.
3. KEYSTONE -- `--config` overrides ambient env: `export LOKI_MAX_ITERATIONS=10`,
   config sets 4242 -> dumped == 4242. Proves the whole point.
4. auto `.loki/config.yaml` LOSES to `--config`; AND ambient env still BEATS auto
   `.loki/config.yaml` (unchanged-contract regression).
5. `${VAR}` expands from env; `${UNSET}` -> key skipped + warning emitted.
6. Raw-secret literal -> warning on load; non-zero on `config validate`; a
   `${VAR}`-ref value -> no warning (deny-filter path).
7. Format parity (WITH ambient env present -- mandatory): export a conflicting
   ambient `LOKI_*`, then load the same logical config as `.env`, `.yaml`, AND
   `.json` -> all three produce IDENTICAL dumped exports == the config value (NOT
   the ambient value). Setting ambient env is required: the override defect only
   surfaces when env is present (with env absent all three pass vacuously), so a
   parity test without ambient env would not catch a YAML/JSON env-wins regression.
8. Injection: value with `$(...)` / backticks / `;` rejected by
   validate_yaml_value, never executed (sentinel-absent + value-not-exported).
9. Bad/missing/symlink file -> honest non-zero exit, no silent default fallback.
10. Drift test: every var in LOKI_CONFIG_MAP is consumed in run.sh (grep each
    LOKI_* target has a `${LOKI_...:-` reader); report any unmapped LOKI_* so
    coverage growth is measurable. Asserts T1==T2 (both now iterate the array).
11. cmd_start no-op-arm test: `loki start --config f.env ./prd.md` -> prd_file is
    ./prd.md (the path is NOT misread as the PRD positional), and `--config` is
    NOT forwarded to the exec target.
12. Bash/Bun parity harness (task #630) green; `bash scripts/local-ci.sh` green;
    `bash tests/run-shellcheck.sh` clean on the new lib. Register a new
    `test-config-file.sh` in tests/run-all-tests.sh (alongside the
    `test-deploy.sh` registration at run-all-tests.sh:218).

Full SDLC fleet (Architect -> PO -> dev -> SDET -> 3/3 council) -> ship as own
MINOR release.

--------------------------------------------------------------------------------
## 8. Docs to update + version bump

Docs (content updates, NOT version-gated):
- README.md, docs/INSTALLATION.md, DOCKER_README.md, wiki: `loki start --config
  <path>` (+ `--vars` / `--env-file`), the precedence ladder, `${VAR}` syntax, the
  secret rule, `config example|schema|validate`.
- docker-compose.yml: show mounting a config file + that config > env; secrets stay
  in `.env` / mounted OAuth. `.env.example`: note `.env` is the flat full-surface
  form.
- deploy/helm/autonomi/values.yaml + deployment-controlplane.yaml +
  deployment-worker.yaml: document mounting config as a ConfigMap volume +
  `--config /etc/loki/config.yaml`; secrets stay in the existing
  Secret/`existingSecret` (Vault-ready) path, referenced via `${VAR}`.
- autonomy/config.example.yaml: regenerate (or note it is now generated by
  `config example`); drop the dead `compaction_interval`.

Version bump -- INTEGRATOR ONLY, single release commit (per CONTRIBUTING.md:120,
devs must NOT bump versions; merge-conflict avoidance). The canonical 14 locations
(references/deployment.md:610): VERSION, package.json, SKILL.md (header + footer),
Dockerfile, Dockerfile.sandbox, vscode-extension/package.json, CLAUDE.md,
dashboard/__init__.py, mcp/__init__.py, CHANGELOG.md, docs/INSTALLATION.md,
wiki/Home.md, wiki/_Sidebar.md, wiki/API-Reference.md. Plus 4-channel validation.
NOTE for the integrator: the documented 14-list and the OBSERVED v7.73.0 bump set
diverge -- v7.73.0 also touched plugins/loki-mode/.claude-plugin/plugin.json and
loki-ts/dist/loki.js (not in the documented 14), while the documented list includes
vscode-extension/package.json and wiki/API-Reference.md (which v7.73.0 did not
touch). Reconcile against the actual repo at release time rather than trusting
either list blindly.

--------------------------------------------------------------------------------
## 9. Phasing

- v1 (this plan, one release): `--config`/`--vars`/`--env-file` pre-pass; `.env` +
  YAML + JSON; locked precedence; shared config-map.sh (pays down drift debt: 3
  tables -> 1); `${VAR}` expansion + raw-secret warning; extracted
  `validate_config_key`; `config example|schema|validate`; drift + mutation tests.
  Satisfies "all flags configurable" via `.env` immediately.
- v2 (next release, ADDITIVE only -- never re-touch precedence): grow nested
  friendly-key schema to the full ~250-flag surface; wire a real consumer for
  `model.compaction_interval`; optionally unify settings.json map with
  LOKI_CONFIG_MAP; optionally unify init/edit(YAML) vs set/get(settings.json).

--------------------------------------------------------------------------------
## 10. Critical files (verified line anchors, post-v7.73.0 working tree)

- autonomy/loki -- main() pre-pass insert after 15302/before 15309; session-gate
  on the start/run/quick arms (15314+); cmd_start arg loop 1042 (add no-op
  --config/--vars/--env-file arms); exec handoff 2097; cmd_config dispatch
  8089-8137 (+3 subcommands); EXTRACT validators 8177-8244 -> validate_config_key.
- autonomy/run.sh -- load_config_file 228-259 (unchanged routing);
  parse_simple_yaml 262-350 and parse_yaml_with_yq 419-504 (refactor to iterate
  LOKI_CONFIG_MAP); set_from_yaml 389-416; validate_yaml_value 353-379;
  _load_json_settings 522-566 (JSON safe-pattern reuse); secret patterns
  _commit_scan_secret_file 6331-6382 (reuse for raw-secret check); AUTO_FIX clobber
  625-627 (test caveat).
- autonomy/lib/config-map.sh -- NEW: canonical LOKI_CONFIG_MAP (64 keys) +
  loki_maybe_apply_config_file + loki_apply_config_file + .env parser + ${VAR}
  expander + format detect; side-effect-free on source.
- autonomy/config.example.yaml -- basis for generated `config example`; drop dead
  compaction_interval.
- deploy/helm/autonomi/values.yaml + deployment-controlplane.yaml +
  deployment-worker.yaml -- the envFrom injection that makes --config > env
  necessary; doc/mount updates.
- tests/test-config-file.sh (NEW) + tests/run-all-tests.sh (register near :218).
