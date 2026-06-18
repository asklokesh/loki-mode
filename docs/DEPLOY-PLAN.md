# DEPLOY-PLAN.md -- `loki deploy` (ADVISORY / PRINT-ONLY)

**Feature:** `loki deploy` -- detect project type + the user's installed cloud CLI,
PRINT (and best-effort copy) the canonical deploy command(s), and **never run them**.

**Status:** Architecture plan. No implementation code here. Pattern family: the just-shipped
`loki preview --public` (`_preview_public` at `autonomy/loki:5306`, helpers from `_read_app_state`
at `:5216`, arg parsing in `cmd_preview` at `:5546`-`:5609`, dispatch arm `preview)` at `:14966`).

**Why this exists / why it is safe.** README states (line 447) *"Does not deploy -- human runs
deploy commands"* and (line 452) *"It does NOT access your cloud accounts ... Human oversight is
expected for deployment."* This feature keeps that literally true: it is an **advisory printer**.
It runs `command -v <cli>` ONLY (never the CLI itself, not even `--version`), prints the exact
command, and the **human runs it**. Fully reversible; touches no cloud account.

---

## Product Owner scope locks (RECOMMENDED -- integrator to confirm)

These are the decisions the Product Owner / integrator should lock before build. Each has a
clear recommended default.

### LOCK 1 -- Command surface: NEW top-level command `loki deploy` (not a flag)
- Recommendation: **new top-level `deploy)` dispatch arm + `cmd_deploy()`**, NOT `loki preview --deploy`.
- Justification: `preview` is "show me the local app I already built/started" and is gated on a
  **running app** (`state.json` status=running, live port). `deploy` is conceptually distinct:
  it is a **static, filesystem-only advisory about project type** that must work with nothing
  running and no build started. Folding it into `preview` would force the running-app
  preconditions onto a feature that must not have them (see LOCK 6). Per the CLI-consolidation
  mandate (`autonomy/loki:675`, lean ~17-entry front page), `deploy` does **not** go on the
  front-page command list; it lives in the "More commands" footer (`:728`) and is fully
  documented via `loki deploy --help`. It earns a command (verb users already expect) but not
  front-page real estate.

### LOCK 2 -- Disambiguation: print ALL viable options, most-idiomatic first
- Recommendation: when several `(project-type x installed-CLI)` pairs are viable, **print every
  viable option, clearly labeled, idiomatic one first.** Never silently pick one.
- Precedence (the "idiomatic first" order), recommended default:
  | Detected project type | Idiomatic 1st | Then (if that CLI also installed) |
  |---|---|---|
  | Next.js | Vercel | Netlify, Fly (if Dockerfile present) |
  | Static / SPA (dist/ or build/ + index.html; Vite/CRA) | Netlify | Cloudflare Pages, Vercel |
  | Dockerfile / containerized server | Fly | Cloudflare (wrangler), (Render: doc link only) |
  | Generic Node server (package.json, no static build) | Fly | Vercel |
  | Python (requirements.txt / pyproject.toml) | Fly | (doc links: Render/Railway) |
  - Within each row, only print options whose **CLI is actually installed** (`command -v`).
  - "Idiomatic first" = ordering only; it never suppresses a viable installed alternative.

### LOCK 3 -- Per-provider canonical commands (DOCUMENTED, not invented)
Confidence column: "task" = exactly the form specified in the approved task brief (authoritative
for this build); placeholders are `<...>` the user fills. No flag is invented.

| Provider | CLI binary (`command -v`) | Command printed | Notes / placeholders | Confidence |
|---|---|---|---|---|
| Vercel | `vercel` | `vercel --prod` | none | task / high |
| Netlify | `netlify` | `netlify deploy --prod` | for **static**, append `--dir=<build-output>` (e.g. `dist` or `build`); print the placeholder, do not guess | task / high |
| Fly.io | `flyctl` | `fly deploy` | **Detect `flyctl`, print `fly deploy`** -- the binary is `flyctl` but the canonical subcommand verb is `fly deploy`; this is intentional, not a typo. If no `fly.toml`, append a one-line note: "run `fly launch` once first to create fly.toml" (note text only, never executed) | task / high |
| Cloudflare Pages (static) | `wrangler` | `wrangler pages deploy <build-output>` | placeholder dir | task / high |
| Cloudflare Workers/containers | `wrangler` | `wrangler deploy` | none | task / high |

- Where a flag depends on the project (build dir), print a `<placeholder>` and reference official
  docs rather than inventing. Each printed block ends with the provider's official docs URL.
- **A wrong flag is worse than no feature** -- conservatism over completeness.

### LOCK 4 -- Clipboard: best-effort, cross-platform, never fatal, copy the idiomatic one
- Recommendation: **always copy the idiomatic (first) command**, and print a note:
  `copied to clipboard: <cmd>  (other options shown above)`. Cleaner than "copy only when exactly one".
- TTY gate: skip clipboard entirely when `[ ! -t 1 ]` (meaningless over SSH / pipes / non-TTY).
- Tools, in order, guarded by `command -v`: `pbcopy` (macOS); `wl-copy`, `xclip -selection clipboard`,
  `xsel --clipboard --input` (Linux); `clip.exe`/`clip` (Windows/WSL).
- **Never fatal:** `printf '%s' "$cmd" | <tool> 2>/dev/null || true`. If no tool exists, print is the
  primary output and the command still exits 0. Clipboard failure never changes the exit code.
- These clipboard tools ARE allowed to run. Only the FOUR cloud CLIs are forbidden (LOCK 5).

### LOCK 5 -- NON-EXECUTION is a tested invariant
- The command must **NEVER** invoke vercel / netlify / flyctl / wrangler -- not even `--version`.
- Detection is **`command -v <cli>` ONLY**. No `$cli ...` call anywhere in the code path.
- Proven by SDET test (see Section 8, headline test): PATH stubs for all four that write a sentinel
  IF invoked; after `loki deploy` runs, assert all four sentinels ABSENT **and** the expected
  command string was printed (both halves -- sentinel-absent alone passes vacuously).

### LOCK 6 -- Filesystem-only; NOT gated on a running app
- `loki deploy` is a static advisory. It must work with **nothing running, no build started.**
- It does **NOT** read `app-runner/state.json` and has **no** status=running / live-port
  precondition (this is the key divergence from `_preview_public`). Detection is from project
  files in the target dir, using the same `${TARGET_DIR:-.}` resolution app-runner uses.
- Only two real preconditions: (a) a project type is detected, else honest non-zero exit;
  (b) at least one matching CLI is installed, else honest install hint + non-zero exit.

### LOCK 7 -- Bun parity: bash-only is acceptable
- bash-only, no Bun runner change. Precedent: HUD (`FEAT-HUD`) and preview (`FEAT-PREVIEW-LINK`)
  are bash-only; the Bun runner is dormant for the live/advisory path. State explicitly in CHANGELOG.

---

## 1. Project-type detection (filesystem signals)

Reuse the signals already proven in `autonomy/app-runner.sh`. All checks are read-only file/dir
existence + `grep` on `package.json`. Resolve the directory as `local dir="${TARGET_DIR:-.}"`
(same idiom as `app_runner_init` at `app-runner.sh:739` and `_detect_nextjs_standalone` at `:594`).

Detection cascade (first match wins for the *primary* type label; multiple provider options can
still be offered per LOCK 2):

| # | Type | Signal (exact checks) | Source in repo |
|---|---|---|---|
| 1 | Next.js | `grep -q '"next"' "$dir/package.json"` OR `[ -f "$dir/next.config.js" ]` OR `next.config.mjs`/`next.config.ts` present | mirrors next detection near `app-runner.sh:800-813` |
| 2 | Static / SPA | (`[ -d "$dir/dist" ]` OR `[ -d "$dir/build" ]`) AND a built `index.html` in that dir; OR `grep -q '"vite"' package.json` / CRA (`react-scripts`) | vite signal at `app-runner.sh:697` |
| 3 | Dockerfile / container | `[ -f "$dir/Dockerfile" ]` (and/or `docker-compose.yml`/`compose.yml`) | `app-runner.sh:759`, `:774` |
| 4 | Generic Node server | `[ -f "$dir/package.json" ]` with a `"start"`/`"dev"` script and no static build dir | `app-runner.sh:798`, `:814`, `:821` |
| 5 | Python | `[ -f "$dir/requirements.txt" ]` OR `[ -f "$dir/pyproject.toml" ]` | `app-runner.sh:953` |

- Do **not** call `_detect_nextjs_standalone`'s artifact-only path as the sole Next signal; for an
  advisory we want the *source* signal (`"next"` in package.json / `next.config.*`) since the build
  may not have run yet. (The artifact path keys on `.next/standalone/server.js` -- too narrow here.)
- Type -> candidate providers per the LOCK 2 precedence table.
- If **no** type matches: honest "no deployable project detected here" message naming the signals
  it looked for (package.json / Dockerfile / dist|build / requirements.txt|pyproject.toml), non-zero exit.

---

## 2. Command surface + dispatch wiring

### 2.1 Dispatch arm (new, contiguous block placement)
Add a `deploy)` arm to the dispatch `case` next to `preview)` (`autonomy/loki:14966`):
```
        deploy)
            cmd_deploy "$@"
            ;;
```
No deprecated alias (brand-new verb; nothing to alias).

### 2.2 Function placement -- CONTIGUOUS, for test extractability
Place ALL deploy code as **one contiguous block** so the SDET test can extract it by name anchor
the same way `test-preview-public.sh` extracts the preview block (awk from the first helper def to
the closing `}` of `cmd_deploy`). Recommended location: immediately AFTER `cmd_preview()` ends
(after `autonomy/loki:5649`-area close), so the two advisory features sit together. The block:
- `_deploy_detect_type()`     -- echoes the primary type label (Section 1); always returns 0.
- `_deploy_options_for_type()`-- given type, echoes ordered `provider|cli|command` rows (pure, testable).
- `_deploy_copy_clipboard()`  -- best-effort copy (LOCK 4); always returns 0; TTY/`command -v` guarded.
- `cmd_deploy()`              -- arg parse + orchestration + printing.

Keep helpers pure where possible (take dir / type as args, echo to stdout, `return 0`) so unit
tests can call them directly without a process -- mirrors the pure extractors `_extract_tunnel_url_*`.

### 2.3 `cmd_deploy()` flow
1. Parse args in a `while [ $# -gt 0 ]` loop (mirror `cmd_preview` `:5555`):
   - `--help|-h|help` -> print help block (Section 2.4), `return 0`.
   - `--dir <path>` -> override the project dir to scan (default `${TARGET_DIR:-.}` then `.`).
   - `--no-clip` -> disable clipboard copy.
   - `--json` -> machine-readable output (optional; see 2.5). Lenient on unknown args (no hard
     error -> no behavior drift), matching `cmd_preview`. Guard value-consuming shifts exactly as
     `--provider` does at `:5595`-`:5599` (avoid set -e underflow when a flag is the last arg).
2. `type=$(_deploy_detect_type "$dir")`.
3. If empty -> no-project path: honest message + `return 1`.
4. `options=$(_deploy_options_for_type "$type")`; filter to rows whose CLI is installed
   (`command -v "$cli" >/dev/null 2>&1`).
5. If zero installed CLIs -> no-CLI path: honest install hints for each candidate provider
   (brew + official URL), `return 1` (Section 3).
6. Else: print a header (detected type), then each installed option block (label, command,
   docs URL), idiomatic first. Best-effort copy the first command (LOCK 4). `return 0`.
7. **Never** call any cloud CLI. Print only.

### 2.4 `--help`
Mirror the `cmd_preview` help block (`:5557`-`:5585`). Must state: advisory/print-only; it does NOT
deploy and does NOT run any cloud CLI; it detects project type + your installed CLI and prints the
command for YOU to run; clipboard is best-effort. List options `--dir`, `--no-clip`, `--json`, `--help`.

### 2.5 `--json` (optional, recommended)
Emit `{"type": "...", "options": [{"provider","cli","command","docs"}], "copied": "<cmd|>"}`.
Honest: empty `options` when no CLI installed. Suppress clipboard note under `--json`.

---

## 3. No-CLI-installed path (honest install hints)

Mirror the gh-missing / tunnel-missing block at `autonomy/loki:5413`-`:5433`. For each candidate
provider for the detected type, print to **stderr**, then `return 1`:
```
No deploy CLI found for this <type> project.
Loki never accesses your cloud account or runs deploy for you -- you run the printed command.
Install one of the following, then re-run 'loki deploy':

  Vercel:      brew install vercel       |  https://vercel.com/docs/cli
  Netlify:     brew install netlify-cli  |  https://docs.netlify.com/cli/get-started/
  Fly.io:      brew install flyctl       |  https://fly.io/docs/flyctl/install/
  Cloudflare:  npm i -g wrangler         |  https://developers.cloudflare.com/workers/wrangler/install-and-update/
```
- NEVER fabricate success; NEVER download a binary. Only print candidates relevant to the type.
- Non-zero exit so scripts/CI see the failure.

## 3b. No-detected-project path
Honest message to stderr naming the signals checked (Section 1), `return 1`.

---

## 4. set -e / shellcheck safety (file runs under `set -euo pipefail`)

- Increment counters as `i=$((i + 1))` (never `((i++))`, which returns 1 at zero and aborts).
- All `grep`/`command -v` that may "fail" guarded: `grep -q ... || true` or `if command -v ...`.
- Quote every path: `"$dir"`, `"$dir/package.json"`. Pass paths as argv to any python helper
  (never interpolate into a heredoc) -- mirror `_read_app_state` (`:5219`-`:5227`).
- If a python heredoc is used (e.g. for `--json`), escape `$` that bash must not expand
  (`\$`); follow `tests/check-heredoc-dollar-digit.sh` (the repo gate for `$1`/`$2` in heredocs).
- Clipboard pipeline always `|| true`; never let a missing tool or non-TTY abort.
- Value-consuming flag shifts guarded (`[ $# -ge 2 ] && shift`) -- see `:5595`.
- Capture sub-function exit into a local then `return $rc` (don't bare-return a non-zero call line
  under set -e) -- mirror `:5614`-`:5617`.
- Must pass `tests/run-shellcheck.sh` clean.

---

## 5. SDET test plan -- `tests/test-deploy.sh` (NEW)

Structure mirrors `tests/test-preview-public.sh`: extract the contiguous deploy block by name anchor
into a temp lib, source it, drive `cmd_deploy` and the pure helpers. `pass/fail` counters, `mktemp -d`
WORKROOT, `trap cleanup EXIT INT TERM`. Color globals exported empty. Every un-runnable case emits a
visible FAIL/SKIP -- never a silent pass. Fixtures live under temp dirs (fake package.json,
Dockerfile, dist/index.html, requirements.txt).

Extraction sanity (non-vacuity gate, like preview lines 113-126): assert all 4 deploy function
defs are present in the extracted lib, else fail loudly and abort.

### Test 1 (HEADLINE) -- NON-EXECUTION invariant
- Build a `fake-bin` with stubs `vercel`, `netlify`, `flyctl`, `wrangler`, each:
  `#!/usr/bin/env bash` -> `echo ran > "$SENTINEL_<name>"` -> `exit 0`.
- Prepend `fake-bin` to PATH so `command -v` RESOLVES all four (CLIs DETECTED + printed).
- Fixture: a Next.js project dir (package.json with `"next"`).
- Run `cmd_deploy --dir <fixture>`; capture stdout.
- Assert BOTH halves:
  1. **NONE** of the four sentinels exists (no cloud CLI was invoked) -- the core invariant.
  2. The expected command string (`vercel --prod`) **was printed** (proves non-vacuity -- a
     deploy that prints nothing would pass half 1 falsely).
- This is the highest-stakes test (echoes the real tunnel-CLI-launched-during-dev incident).

### Test 2 -- Project-type detection (pure helper, per type)
For each fixture (Next.js / static dist+index.html / Dockerfile / generic Node / Python), assert
`_deploy_detect_type "$dir"` returns the expected label. Include a "none" fixture (empty dir) ->
empty label.

### Test 3 -- Option ordering / idiomatic-first (pure helper)
With all four stubs on PATH, assert `_deploy_options_for_type next` lists Vercel before Netlify
before Fly; static lists Netlify/Cloudflare before Vercel; Dockerfile lists Fly first. Assert the
printed command strings are EXACTLY the LOCK 3 canonical forms (mutation-proof: a wrong flag fails).

### Test 4 -- No-CLI-installed path
Curated clean PATH with NONE of the four CLIs (build_clean_bin idiom, preview lines 191-201;
symlink only coreutils). Next.js fixture. Assert: honest install hint printed (contains
"Install one of the following" and at least the Vercel brew + URL) AND non-zero exit AND no sentinel.

### Test 5 -- No-detected-project path
Empty dir fixture. Assert honest "no deployable project" message naming signals + non-zero exit.

### Test 6 -- Clipboard best-effort, never fatal
- 6a: PATH with NO clipboard tool (clean bin) + Next.js fixture + on a non-TTY (`</dev/null` /
  piped stdout). Assert exit 0 and the command still PRINTED (clipboard absence is non-fatal).
- 6b (if a clipboard tool exists on host or via a fake `pbcopy` stub that writes a file): assert the
  idiomatic command was copied AND the "copied to clipboard" note printed. Fake pbcopy is allowed to
  run (it is not a cloud CLI). SKIP-safe if no TTY can be simulated.

### Test 7 -- `--json` honesty (if implemented)
Assert valid JSON; `options` empty when no CLI installed; non-empty with correct commands when stubs
present. Suppresses the clipboard note.

### Test 8 -- set -e safety / no-abort
Run a representative `cmd_deploy` invocation inside a `set -e -o pipefail` subshell and assert it
reaches a sentinel "ALIVE" echo after the call (proves no spurious abort), mirroring preview 1b
(lines 304-314).

### Wiring into `tests/run-all-tests.sh`
Add next to the preview registration (`tests/run-all-tests.sh:204`):
```
run_test "Deploy Advisory (print-only, non-execution invariant)" "$SCRIPT_DIR/test-deploy.sh"
```
Also covered transitively by `tests/run-shellcheck.sh` and the mutation/mock detectors (gates #8/#9).

---

## 6. Docs to update on release

- `README.md:447` -- change the Deploy "What Works" cell to note advisory-print: e.g.
  "Generates configs/Dockerfiles/CI-CD; `loki deploy` prints the exact deploy command (advisory)".
  Keep "What Doesn't (Yet)": "Does not run deploy -- human runs the printed command." Line 452's
  "Human oversight is expected for deployment" stays TRUE and unchanged.
- `CHANGELOG.md` -- new feature entry (FEAT-DEPLOY): advisory print-only `loki deploy`; non-execution
  invariant; filesystem-only detection; best-effort clipboard; bash-only (Bun parity note).
- `docs/INSTALLATION.md` -- optional "Deploying your build" note pointing at `loki deploy`.
- `wiki/CLI-Reference.md` -- add the `deploy` command entry + options.
- `skills/production.md` (and `skills/00-index.md` if it indexes commands) -- document the advisory
  deploy step in the production workflow.
- Create this plan's sibling precedent set is `docs/PREVIEW-LINK-PLAN.md` / `docs/BUILD-HUD-PLAN.md`
  -- this file (`docs/DEPLOY-PLAN.md`) is the matching plan artifact.

---

## 7. Critical files for implementation

- /Users/lokesh/git/loki-mode/autonomy/loki  (cmd_deploy + helpers as a contiguous block after cmd_preview ~:5649; dispatch arm next to preview ~:14966; "More commands" footer ~:728)
- /Users/lokesh/git/loki-mode/autonomy/app-runner.sh  (detection signal source: next ~:800-813, vite ~:697, Dockerfile ~:759/:774, python ~:953, ${TARGET_DIR:-.} idiom ~:739)
- /Users/lokesh/git/loki-mode/tests/test-deploy.sh  (NEW -- mirror tests/test-preview-public.sh)
- /Users/lokesh/git/loki-mode/tests/run-all-tests.sh  (register the new test near :204)
- /Users/lokesh/git/loki-mode/README.md  (line 447 Deploy row -> advisory-print)
