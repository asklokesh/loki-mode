#!/usr/bin/env bash
# FC-REPO-BUNFIG-AND-ENV-REACH-ORCHESTRATOR (RQ-07): bun loads the cwd bunfig.toml (preload =
# code) and .env, and the cwd of `loki` is the user's repo. bin/loki must start every Loki CLI
# bun with --config=/dev/null --no-env-file. Part 1: a stub bun records argv on each route.
# Part 2: real bun, hostile repo (bunfig preload + .env), marker files prove nothing ran.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

T="$(mktemp -d "${TMPDIR:-/tmp}/bun-entry-cfg.XXXXXX")"
trap 'rm -rf -- "$T"' EXIT

mkdir -p "$T/root/bin" "$T/root/autonomy" "$T/stubbin" "$T/home" "$T/hostile" "$T/clean"
cp "$REPO/bin/loki" "$T/root/bin/loki"
cp "$REPO/autonomy/telemetry.sh" "$T/root/autonomy/telemetry.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$T/root/autonomy/loki"
chmod +x "$T/root/autonomy/loki" "$T/root/bin/loki"
# Stub bun: one argv entry per line, appended; --version answers the resolver probe.
cat >"$T/stubbin/bun" <<STUB
#!/usr/bin/env bash
[ "\${1:-}" = "--version" ] && { echo 1.3.13; exit 0; }
printf '%s\n' "\$@" >"$T/argv"
exit 0
STUB
chmod +x "$T/stubbin/bun"

ENTRY="$T/entry.ts"
cat >"$ENTRY" <<'TS'
import { writeFileSync } from "node:fs";
const out = process.env.MARKER_DIR ?? ".";
writeFileSync(`${out}/entry-ran`, "1");
if (process.env.EVIL_FROM_DOTENV) writeFileSync(`${out}/env-evil`, process.env.EVIL_FROM_DOTENV);
if (process.env.LOKI_FROM_DOTENV) writeFileSync(`${out}/env-loki`, process.env.LOKI_FROM_DOTENV);
if (process.env.BUN_FROM_DOTENV) writeFileSync(`${out}/env-bun`, process.env.BUN_FROM_DOTENV);
TS
# Hostile repo: preload runs code, .env sets plain, LOKI_ and BUN_ names.
printf 'preload = ["./evil-preload.ts"]\n' >"$T/hostile/bunfig.toml"
printf 'import { writeFileSync } from "node:fs";\nwriteFileSync(`${process.env.MARKER_DIR}/preload-ran`, "1");\n' >"$T/hostile/evil-preload.ts"
printf 'EVIL_FROM_DOTENV=plain\nexport LOKI_FROM_DOTENV="x"\nBUN_FROM_DOTENV=y\n' >"$T/hostile/.env"

TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
TO=()
[ -n "$TIMEOUT_BIN" ] && TO=("$TIMEOUT_BIN" -k 5 40)
REAL_BUN_DIR="$(dirname "$(command -v bun 2>/dev/null || echo /usr/bin/bun)")"

run_stub() { # run_stub <args...>; argv the stub bun saw (one per line) on stdout
    rm -f "$T/argv"
    (cd "$T/clean" && env -i HOME="$T/home" PATH="$T/stubbin:/usr/bin:/bin" LOKI_TELEMETRY_DISABLED=1 \
        LOKI_TS_ENTRY="$ENTRY" ${TO[@]+"${TO[@]}"} bash "$T/root/bin/loki" "$@") >/dev/null 2>&1
    cat "$T/argv" 2>/dev/null || true
}
assert_flags() { # assert_flags <label> <args...>
    local label="$1"; shift
    local got; got="$(run_stub "$@")"
    local a1 a2 a3
    a1="$(printf '%s\n' "$got" | sed -n 1p)"; a2="$(printf '%s\n' "$got" | sed -n 2p)"; a3="$(printf '%s\n' "$got" | sed -n 3p)"
    if [ "$a1" = "--config=/dev/null" ] && [ "$a2" = "--no-env-file" ] && [ "$a3" = "$ENTRY" ]; then
        ok "$label: argv = --config=/dev/null --no-env-file <entry>"
    else
        bad "$label: want '--config=/dev/null --no-env-file $ENTRY' first, got '$(printf '%s' "$got" | tr '\n' ' ')'"
    fi
}

# Part 1: every route that execs the Bun CLI.
assert_flags "version" version
assert_flags "status" status
assert_flags "start --spec" start --spec spec.md
assert_flags "start --attempts 2" start --attempts 2 --no-pr
assert_flags "start --dry-run" start prd.md --dry-run
assert_flags "modernize --to" modernize repo --to ts
assert_flags "engine10 route (fix x)" "fix x"
assert_flags "doctor" doctor

# The doctor preflight probe (`bun <cli> version`) is not an exec; it must carry the flags too.
rm -f "$T/argv"
grep -n '_doctor_bun" ' "$REPO/bin/loki" | grep -q '_LOKI_BUN_SAFE_FLAGS' \
    && ok "doctor preflight probe carries the safe flags" || bad "doctor preflight probe lacks the safe flags"

# No bare "$BUN_CLI" bun call may remain outside _loki_exec_bun and the preflight.
leaks="$(grep -nE '(exec +)?("\$[A-Za-z_]+"|bun) +"\$BUN_CLI"' "$REPO/bin/loki" | grep -v '_LOKI_BUN_SAFE_FLAGS' || true)"
[ -z "$leaks" ] && ok "no bun call bypasses the safe flags" || bad "bun call bypasses the safe flags: $leaks"

# Part 2: real bun.
if [ -x "$REAL_BUN_DIR/bun" ]; then
    run_real() { # run_real <cwd> <markerdir> <env...> -- <args...>
        local cwd="$1" md="$2"; shift 2
        local envs=()
        while [ "$1" != "--" ]; do envs+=("$1"); shift; done
        shift
        (cd "$cwd" && env -i HOME="$T/home" PATH="$REAL_BUN_DIR:/usr/bin:/bin" LOKI_TELEMETRY_DISABLED=1 \
            LOKI_TS_ENTRY="$ENTRY" MARKER_DIR="$md" ${envs[@]+"${envs[@]}"} \
            ${TO[@]+"${TO[@]}"} bash "$T/root/bin/loki" "$@") >/dev/null 2>&1
    }
    # Fixture is live: bare bun in the hostile repo does run the preload and load .env.
    M0="$T/m0"; mkdir -p "$M0"
    (cd "$T/hostile" && env -i HOME="$T/home" PATH="$REAL_BUN_DIR:/usr/bin:/bin" MARKER_DIR="$M0" bun "$ENTRY") >/dev/null 2>&1
    if [ -f "$M0/preload-ran" ] && [ -f "$M0/env-evil" ]; then ok "control: bare bun in the hostile repo runs the preload and reads .env"; else bad "control: fixture inert (preload=$([ -f "$M0/preload-ran" ] && echo y || echo n) env=$([ -f "$M0/env-evil" ] && echo y || echo n))"; fi

    for route in "version" "start --help"; do
        M="$T/m-$(printf '%s' "$route" | tr -c 'a-z' _)"; mkdir -p "$M"
        run_real "$T/hostile" "$M" -- $route
        [ ! -e "$M/preload-ran" ] && ok "loki $route: repo bunfig preload did not run" || bad "loki $route: repo bunfig preload RAN"
        [ ! -e "$M/env-evil" ] && [ ! -e "$M/env-loki" ] && [ ! -e "$M/env-bun" ] \
            && ok "loki $route: repo .env not applied" || bad "loki $route: repo .env applied"
    done

    # Opt-in: plain names apply, LOKI_* and BUN_* never do, preload still blocked.
    M="$T/m-optin"; mkdir -p "$M"
    run_real "$T/hostile" "$M" LOKI_ALLOW_PROJECT_ENV=1 -- version
    [ "$(cat "$M/env-evil" 2>/dev/null)" = "plain" ] && ok "opt-in: plain .env name applied" || bad "opt-in: plain .env name not applied"
    [ ! -e "$M/env-loki" ] && ok "opt-in: LOKI_* from .env never applied" || bad "opt-in: LOKI_* from .env applied"
    [ ! -e "$M/env-bun" ] && ok "opt-in: BUN_* from .env never applied" || bad "opt-in: BUN_* from .env applied"
    [ ! -e "$M/preload-ran" ] && ok "opt-in: preload still blocked" || bad "opt-in: preload ran"
    # A variable already in the environment wins over .env.
    M="$T/m-envwins"; mkdir -p "$M"
    run_real "$T/hostile" "$M" LOKI_ALLOW_PROJECT_ENV=1 EVIL_FROM_DOTENV=real -- version
    [ "$(cat "$M/env-evil" 2>/dev/null)" = "real" ] && ok "opt-in: real environment wins over .env" || bad "opt-in: .env overrode the real environment"

    # Positive control: a normal repo still runs the entry.
    M="$T/m-clean"; mkdir -p "$M"
    run_real "$T/clean" "$M" -- version
    [ -f "$M/entry-ran" ] && ok "positive control: normal repo reaches the entry" || bad "positive control: entry did not run in a normal repo"
else
    bad "real bun not found; hostile-repo part cannot run"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
