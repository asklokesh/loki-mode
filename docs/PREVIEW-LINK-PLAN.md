# PREVIEW-LINK-PLAN.md -- Public Preview Link (BYO-tunnel)

## Product Owner scope locks (decided 2026-06-18)
1. Command surface: `loki preview --public` (a flag on the existing command, NOT a new top-level command and NOT `loki share preview` which is a deprecated alias to report-gist). Respects the CLI-consolidation mandate.
2. Lifecycle: FOREGROUND-blocking with a trap teardown + "Press Ctrl+C to stop sharing." (Safer than background+pidfile: no orphaned public tunnel a user forgets about.)
3. Default provider / detection order: cloudflared first (quick tunnels need NO account), ngrok second (needs authtoken). `--provider cloudflared|ngrok` override.
4. Host-header rewrite: default-ON (cloudflared `--http-host-header localhost`, ngrok `--host-header=rewrite`) with a `--no-host-rewrite` escape. Fixes the #1 dev-server "Invalid Host header" failure.
5. Bun parity: bash-only is acceptable for v7.72.0 (HUD precedent; the Bun runner is dormant for the live path). No loki-ts mirror required now.
6. Consent: explicit, default-NO. Interactive `[y/N]` on a TTY (only ^[Yy] proceeds); `--yes` skips the prompt but still prints the warning; non-TTY without `--yes` REFUSES.

## 1. Goal
Loki builds + runs the app locally and `loki preview` (cmd_preview, autonomy/loki:5212) opens it at http://localhost:PORT. There is no way to share the running app. Add a consent-gated `--public` path that creates a PUBLIC URL for the already-running local app by wrapping the USER'S OWN tunnel CLI (cloudflared or ngrok). The app + the user's creds stay on their machine; Loki never proxies traffic and never bundles/downloads a binary. Delivers the "share what was built" wow (Replit/Lovable/Bolt have it) without breaking "your keys, nothing leaves your network."

## 2. Command surface + dispatch
`loki preview --public` (+ `--provider`, `--yes`, `--no-host-rewrite`). The `preview)` dispatch arm (autonomy/loki:14596 -> cmd_preview "$@") already forwards args; no dispatch-table change. Add the flags to cmd_preview's arg parser (~:5214); `--public` branches into a new `_preview_public` helper BEFORE the existing browser-open logic. Update cmd_preview --help (~:5216-5229).

## 3. Precondition checks (REUSE cmd_preview state.json read)
Refactor the inline parse at autonomy/loki:5246-5263 into a shared `_read_app_state <state_file>` echoing url/status/port/primary_service; both the existing browser-open path and `--public` call it (no drift). Then, in order, each with honest degrade + non-zero exit:
1. state.json exists (${LOKI_DIR}/app-runner/state.json) -> else "No app running. loki start / loki status".
2. status == running (mirror :5265) -> else "App is not running (status: X)".
3. URL/port resolved (fallback http://localhost:${port:-3000} per :5271-5273).
4. PORT reachability (NEW): poll with the curl-readiness pattern at autonomy/loki:4979 (curl -s http://localhost:PORT >/dev/null, few retries, sleep 0.5, retries=$((retries+1))). Dead port -> "not exposing a dead port", non-zero. Never tunnel a dead port.

## 4. Consent (load-bearing, default-OFF)
- Interactive TTY ([ -t 0 ]): print the full warning (SS9), prompt `Expose this app publicly? [y/N] ` via `read -r` (idiom at :1897-1902) but DEFAULT-N (only ^[Yy] proceeds; deliberately NOT the default-Y at :1894 -- public exposure is unsafe).
- --yes: skips the prompt; warning still PRINTED.
- Non-TTY without --yes: REFUSE ("Refusing to expose a public tunnel non-interactively without --yes"), non-zero. Never silently expose.

## 5. BYO-CLI detection + install hint (command -v based, so a PATH stub works in CI)
Order (override with --provider): cloudflared, then ngrok, else honest install hint + non-zero. NEVER pretend success, NEVER download a binary. Hint mirrors the gh-missing block at :28304-28311; names brew + official URLs for both; states Loki wraps YOUR OWN client.

## 6. URL extraction (pure, testable: read from file/string, not a live process)
- cloudflared (`cloudflared tunnel --url http://localhost:PORT [--http-host-header localhost]`): quick-tunnel URL prints to stderr/log. Redirect stdout+stderr to ${LOKI_DIR}/preview/cloudflared.log; poll (bounded ~20 x sleep 0.5, tries=$((tries+1))) `grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com'` first match. Timeout no-match -> teardown + non-zero.
- ngrok (`ngrok http PORT [--host-header=rewrite]`): scrape the local API `curl -s http://127.0.0.1:4040/api/tunnels` -> .tunnels[].public_url (prefer https); python3 json parse, grep fallback; bounded poll. No authtoken -> 4040 never comes up -> honest "ngrok config add-authtoken" hint, non-zero.
Factor `_extract_tunnel_url_cloudflared <logfile>` and `_extract_tunnel_url_ngrok <json-file-or-string>` as PURE functions for the stub test.

## 7. Lifecycle (foreground + trap, per lock #2)
- `tunnel_cmd ... > "$log" 2>&1 & tunnel_pid=$!`
- `trap '_preview_public_teardown "$tunnel_pid"' EXIT INT TERM` immediately. Teardown: `kill -TERM "$tunnel_pid" 2>/dev/null || true; sleep 1; kill -KILL "$tunnel_pid" 2>/dev/null || true` + remove log/pidfile (all || true, set -e safe).
- After URL capture: print public URL + live warning + "Press Ctrl+C to stop sharing." Then `wait "$tunnel_pid"`. Ctrl+C -> trap -> clean teardown.
- State dir ${LOKI_DIR}/preview/ (mkdir -p), parallel to app-runner/.

## 8. Host-header (default-ON, lock #4; escape --no-host-rewrite)
Dev servers (Vite/Next dev/webpack/Django ALLOWED_HOSTS) reject a tunneled Host: <random>.trycloudflare.com with "Invalid Host header". cloudflared `--http-host-header localhost`; ngrok `--host-header=rewrite`. Verify the exact flag against the installed CLI version at runtime; do not hardcode blindly. Document that production-style servers may still need the tunnel host added to their allowlist.

## 9. Help + warning copy (honest, no fabricated safety claims)
Help appended to cmd_preview --help: --public, --provider, --yes, --no-host-rewrite (per SS2). Warning printed before the prompt every time:
```
WARNING: This makes the app running on THIS machine reachable by ANYONE who has
the URL, over the public internet, using YOUR tunnel account.
- The app may have NO authentication. Anyone with the link can use it.
- Traffic flows through your own cloudflared/ngrok account, not through Loki.
- This stays up until you stop it. Stop it when you are done.
```
No "secure"/"encrypted" claims beyond what the tunnel CLI itself provides.

## 10. Degrade / error table (all set -e safe)
state.json absent / status!=running / dead port / no CLI / non-TTY-no-yes / URL-capture-timeout / ngrok-no-authtoken -> honest message + non-zero. Consent declined -> "Aborted. App was not exposed." exit 0. Ctrl+C -> trap teardown + "Tunnel stopped." exit 0.

## 11. Test plan (no real tunnel in CI; FAKE binary on PATH + pure extractors)
1. Consent: pipe `n` -> Aborted, no spawn; `y` (fake bin) -> proceeds; --yes skips prompt but prints warning; non-TTY no --yes -> refuse + non-zero.
2. CLI-absent: PATH without cloudflared/ngrok -> install hint + non-zero, no download.
3. URL extraction: cloudflared stub script prints a fixed trycloudflare URL to its log -> assert extractor returns it (+ a real-format log fixture); ngrok extractor against a fixture 4040 JSON -> assert public_url; empty log -> timeout path tears down + non-zero.
4. Preconditions: missing state.json; status=building; unreachable port -> each right message + non-zero.
5. Teardown: SIGINT to the fake-bin run -> child pid gone, log/pidfile cleaned, no orphan.
6. set -e / lint: bash parity + shellcheck/local-ci over the new code (x=$((x+1)), escaped $ in python heredocs, path as argv).
Mirror the existing CLI test harness that covers cmd_preview/gist-share.

## 12. Task list
Agent A (surface, consent, preconditions): extract _read_app_state from :5246-5263 + repoint the existing browser path (regression-test plain `loki preview`); add flags to arg parse; branch --public into _preview_public; preconditions incl port poll (:4979 pattern); consent (warning + default-N + non-TTY/--yes); update --help.
Agent B (detection, extraction, lifecycle): command -v detection + order + hint; pure _extract_tunnel_url_cloudflared / _extract_tunnel_url_ngrok; foreground launch + trap teardown; host-header flags + --no-host-rewrite.
Both: tests per SS11; local-ci/parity gate; v7.72.0 bump + changelog (integrator); no commit/push unless asked.

## Critical files
- autonomy/loki (cmd_preview :5212; arg parse :5214; help :5216-5229; state read to extract :5246-5263; dispatch :14596; consent prompt :1897; nohup/pidfile :4964-4968; curl poll :4979; pgid teardown :2221)
- autonomy/app-runner.sh (state.json writer :104-135 -- url/status/port/primary_service source of truth)
- The bash test harness covering cmd_preview (mirror its PATH-stub + fixture style)
