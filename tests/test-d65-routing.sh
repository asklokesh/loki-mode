#!/usr/bin/env bash
# D63 C5: bin/loki shim routing for D65 features. A probe bun echoes argv so we
# assert WHICH entry the shim chose (cli.ts direct vs engine10) without running
# anything. Last leg runs the real CLI to prove jira intake fails fast with no
# JIRA_* env and never calls the provider.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export LOKI_NO_BROWSER=1

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-d65-route.XXXXXX")" || exit 1
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

ROOT="$WORK/repo"
mkdir -p "$WORK/bin" "$WORK/home" "$ROOT/bin" "$ROOT/autonomy" "$ROOT/loki-ts/dist"
cat > "$WORK/bin/bun" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in --version) echo "1.0.0"; exit 0 ;; esac
echo "ROUTE=BUN args=$*"
exit 0
STUB
chmod +x "$WORK/bin/bun"
cp "$REPO_ROOT/bin/loki" "$ROOT/bin/loki"
printf '#!/usr/bin/env bash\necho "ROUTE=BASH args=$*"\nexit 0\n' > "$ROOT/autonomy/loki"
chmod +x "$ROOT/autonomy/loki"
printf '// stub\n' > "$ROOT/loki-ts/dist/loki.js"

route() {
    env -u LOKI_ENGINE -u LOKI_PROVIDER HOME="$WORK/home" PATH="$WORK/bin:$PATH" \
        LOKI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
        timeout -k 5 30 bash "$ROOT/bin/loki" "$@" 2>/dev/null </dev/null
}

expect() {
    # $1 = label, $2 = expected substring, rest = args
    local label="$1" want="$2" out; shift 2
    out="$(route "$@")"
    case "$out" in
        *"$want"*) ok "$label" ;;
        *) bad "$label (want '$want', got '$out')" ;;
    esac
}

expect "slack serve reaches the Bun CLI directly" "ROUTE=BUN args=$ROOT/loki-ts/dist/loki.js slack serve" slack serve
expect "answer reaches the Bun CLI directly" "ROUTE=BUN args=$ROOT/loki-ts/dist/loki.js answer x" answer x
expect "jira:ABC-1 reaches engine10" "engine10 jira:ABC-1" jira:ABC-1
expect "linear:ENG-2 reaches engine10" "engine10 linear:ENG-2" linear:ENG-2
expect "Linear issue URL reaches engine10" "engine10 https://linear.app/acme/issue/ENG-2/title" https://linear.app/acme/issue/ENG-2/title
expect "start jira:ABC-1 reaches engine10 without start" "dist/loki.js engine10 jira:ABC-1" start jira:ABC-1
expect "start linear:ENG-2 reaches engine10" "engine10 linear:ENG-2" start linear:ENG-2
expect "start Linear URL reaches engine10" "engine10 https://linear.app/acme/issue/ENG-2" start https://linear.app/acme/issue/ENG-2
expect "one-word foo stays legacy" "ROUTE=BASH" foo
expect "start one-word stays legacy" "ROUTE=BASH" start prd.md

# Real-CLI leg: no JIRA_* env must fail fast, name JIRA_BASE_URL, call no provider.
if command -v bun >/dev/null 2>&1 && [ -f "$REPO_ROOT/loki-ts/src/cli.ts" ]; then
    mkdir -p "$WORK/stub" "$WORK/proj"
    ( cd "$WORK/proj" && git init -q . ) >/dev/null 2>&1
    printf '#!/usr/bin/env bash\necho called >> "%s/claude.log"\nexit 0\n' "$WORK" > "$WORK/stub/claude"
    chmod +x "$WORK/stub/claude"
    start=$SECONDS
    out="$(cd "$WORK/proj" && env -u JIRA_BASE_URL -u JIRA_EMAIL -u JIRA_API_TOKEN -u LOKI_ENGINE \
        HOME="$WORK/home" PATH="$WORK/stub:$PATH" BUN_FROM_SOURCE=1 LOKI_TELEMETRY_DISABLED=1 \
        timeout -k 5 20 bash "$REPO_ROOT/bin/loki" jira:ABC-1 2>&1 </dev/null)"
    rc=$?
    elapsed=$((SECONDS - start))
    if [ "$rc" -ne 0 ]; then ok "real jira:ABC-1 without env exits non-zero (rc=$rc)"; else bad "real jira exit was 0"; fi
    if [ "$elapsed" -lt 5 ]; then ok "real jira fails in under 5s (${elapsed}s)"; else bad "real jira took ${elapsed}s"; fi
    case "$out" in *JIRA_BASE_URL*) ok "real jira names JIRA_BASE_URL" ;; *) bad "output lacks JIRA_BASE_URL: $out" ;; esac
    if [ ! -s "$WORK/claude.log" ]; then ok "stub claude logged zero calls"; else bad "stub claude was called"; fi
else
    printf 'SKIP: real-CLI leg (no bun or no loki-ts/src/cli.ts)\n'
fi

printf 'passed=%d failed=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
