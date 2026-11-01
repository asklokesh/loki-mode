#!/usr/bin/env bash
# The five tests/detect-*.sh scripts are quality gates autonomy/run.sh executes on
# the produced project (and the npm package, the claude-code zip and brew ship
# them). Each is run against a clean fixture project (must pass, exit 0) and a
# defective one (must fail under its blocking flag). Hermetic: the dependency
# detector runs with a `curl` shim on PATH, so no network is touched.
#
#   mock-problems          CRITICAL: a test file that imports nothing from the source
#   test-mutations         HIGH: a test that replaces console.error
#   semantic-test-problems HIGH: a variable bound to a literal and asserted equal to it
#   invariant-violations   CRITICAL: a hardcoded credential-format secret in source
#   hallucinated-deps      MISSING: a manifest dependency the registry says does not exist
#
# Planted defect used to prove this test can fail: in tests/detect-mock-problems.sh
# make the CRITICAL no-source-import check report nothing (for example change its
# report call to a no-op); the mock-problems defective case must then fail.
# The same style of plant on any other detector fails its own case. Reverted afterwards.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT" || exit 2

echo "TEST: tests/detect-*.sh quality gates"

SRC='export function add(a, b) { return a + b; }'
GOOD_TEST='import { test, expect } from "bun:test";
import { add } from "./add";
test("adds", () => { expect(add(2, 3)).toBe(5); });'

mkproj() { # mkproj <name> -> $T/<name>/src with add.js and the good test
    mkdir -p "$T/$1/src"
    printf '%s\n' "$SRC" > "$T/$1/src/add.js"
    printf '%s\n' "$GOOD_TEST" > "$T/$1/src/add.test.js"
}

mkproj clean
mkproj mock
printf '%s\n' 'import { test, expect } from "bun:test";' 'test("inline", () => { expect(1 + 1).toBe(2); });' > "$T/mock/src/add.test.js"
mkproj mut
printf '%s\n' 'import { test, expect } from "bun:test";' 'import { add } from "./add";' 'console.error = () => {};' \
    'test("adds", () => { expect(add(2, 3)).toBe(5); });' > "$T/mut/src/add.test.js"
mkproj sem
printf '%s\n' "$GOOD_TEST" 'test("echo", () => {' '  const x = "hello";' '  expect(x).toBe("hello");' '});' > "$T/sem/src/add.test.js"
mkproj inv
# Assembled at run time so this file itself holds no credential-shaped literal.
printf 'const key = "%s%s%s";\n' "sk_" "live_" "4eC39HqLyjWDarjtT1zdp7dc" > "$T/inv/src/cfg.js"

gate() { # gate <script> <dir> <flag> -> prints rc
    LOKI_SCAN_DIR="$2" bash "$ROOT/tests/detect-$1.sh" "$3" >"$T/gate.out" 2>&1
    echo $?
}

for g in "mock-problems --strict" "test-mutations --strict" "semantic-test-problems --strict" "invariant-violations --strict"; do
    name="${g%% *}"; flag="${g##* }"
    rc="$(gate "$name" "$T/clean" "$flag")"
    [ "$rc" = "0" ] && ok "$name: clean fixture passes" || bad "$name: clean fixture exited $rc"
done
rc="$(gate mock-problems "$T/mock" --strict)";                [ "$rc" != "0" ] && ok "mock-problems: defective fixture fails (rc $rc)" || bad "mock-problems accepted a test with no source import"
rc="$(gate test-mutations "$T/mut" --strict)";                [ "$rc" != "0" ] && ok "test-mutations: defective fixture fails (rc $rc)" || bad "test-mutations accepted console.error interception"
rc="$(gate semantic-test-problems "$T/sem" --strict)";        [ "$rc" != "0" ] && ok "semantic-test-problems: defective fixture fails (rc $rc)" || bad "semantic-test-problems accepted a literal echo"
rc="$(gate invariant-violations "$T/inv" --strict)";          [ "$rc" != "0" ] && ok "invariant-violations: defective fixture fails (rc $rc)" || bad "invariant-violations accepted a hardcoded secret"

# hallucinated-deps: a curl shim answers the registry. 404 for the planted name, 200 otherwise.
mkdir -p "$T/shim" "$T/deps-good" "$T/deps-bad"
cat > "$T/shim/curl" <<'SH'
#!/usr/bin/env bash
case "$*" in
    *zz-hallucinated-plant*) printf '404' ;;
    *) printf '200' ;;
esac
SH
chmod +x "$T/shim/curl"
printf '{"name":"x","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n' > "$T/deps-good/package.json"
printf '{"name":"x","version":"1.0.0","dependencies":{"left-pad":"1.3.0","zz-hallucinated-plant":"1.0.0"}}\n' > "$T/deps-bad/package.json"

PATH="$T/shim:$PATH" bash "$ROOT/tests/detect-hallucinated-deps.sh" "$T/deps-good" --strict >"$T/dg.out" 2>&1
[ $? -eq 0 ] && ok "hallucinated-deps: resolvable manifest passes" || bad "hallucinated-deps: resolvable manifest failed: $(tail -2 "$T/dg.out" | tr '\n' ' ')"
PATH="$T/shim:$PATH" bash "$ROOT/tests/detect-hallucinated-deps.sh" "$T/deps-bad" --strict >"$T/db.out" 2>&1
rc=$?
[ "$rc" -ne 0 ] && ok "hallucinated-deps: unresolvable dependency fails (rc $rc)" || bad "hallucinated-deps accepted a missing package"
has "hallucinated-deps names the missing package" "$(cat "$T/db.out")" "zz-hallucinated-plant"

finish
