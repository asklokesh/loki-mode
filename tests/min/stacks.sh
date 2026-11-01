#!/usr/bin/env bash
# Zero-config verification on Maven, Gradle and .NET repos (roadmap R02). The real bin/loki ->
# committed Bun bundle -> engine10 on the stub provider (tests/min/fixtures/e2e/bin/claude, mode
# "stack"), on tiny sample repos under tests/min/fixtures/stacks, with NO environment variable that
# names a stack or a command. Asserts, per stack:
#   real tool on PATH:   the run reaches "Outcome: VERIFIED" through the real mvn / gradle / dotnet.
#                        Needs the tool and its package registry; otherwise it prints SKIP, and
#                        LOKI_STACKS_REQUIRE=1 (set by .github/workflows/pr-fast.yml) turns a SKIP
#                        into a failure, because GitHub ubuntu runners have all three tools.
#   tool missing:        a PATH with no mvn / gradle / dotnet / javac: the outcome is not VERIFIED and
#                        the output names the missing tool and how to install it. Always runs.
#   repo wrapper:        no mvn / gradle on PATH but a repo mvnw / gradlew: VERIFIED through ./mvnw
#                        and ./gradlew with the arguments the engine builds (the wrappers here are
#                        recording stand-ins, so this leg proves selection and arguments, not Maven).
#   committed command:   loki.yaml verify.test_command is what verify runs (no env var).
#   dotnet stand-in:     a fake dotnet that prints VSTest output: VERIFIED when it reports a pass,
#                        not VERIFIED when it reports a failure.
#   parsers:             dotnetSummary and stack detection, unit-level.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/engine10/testmap.ts: stop marking dotnet from DOTNET_MANIFEST_RE (rebuild dist);
#      the dotnet stand-in leg must fail (and the real dotnet leg on a host with the SDK).
#   2. loki-ts/src/util/stack_tools.ts: make missingStackTool return null (rebuild dist); the
#      "names the missing tool" and "install hint" assertions of the three missing-tool legs must fail.
#   3. loki-ts/src/util/dotnet_test.ts: drop the `(m[1] === "Passed") !== (f === 0)` verdict check; the
#      parser contradiction case must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: zero-config Maven, Gradle and .NET verification on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
SAMPLES="$ROOT/tests/min/fixtures/stacks"
TASK="add a multiply(a, b) function"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
BASH_BIN="$(command -v bash)"
REQUIRE="${LOKI_STACKS_REQUIRE:-0}"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 900)

# A PATH with the commands the engine needs and none of mvn, gradle, dotnet, javac (a hermetic
# "tool missing" machine on any host, including CI where all of them are installed).
CLEAN="$T/cleanbin"
mkdir -p "$CLEAN"
for c in bash sh env git python3 python bun node npm npx sed grep awk cat mkdir rm cp mv ls head tail tr sort uniq date \
         dirname basename readlink realpath uname id chmod mktemp timeout wc find xargs tee diff cmp sleep kill ps \
         whoami hostname printf expr touch ln stat du df cut paste less true false test curl; do
    p="$(command -v "$c" 2>/dev/null || true)"
    case "$p" in /*) ln -sf "$p" "$CLEAN/$c" ;; esac
done
for t in mvn gradle dotnet javac java; do
    [ -e "$CLEAN/$t" ] && { echo "$t leaked into the clean PATH" >&2; exit 2; }
done

sample_target() { # sample_target <stack> -> the file the stub edits and the snippet it inserts
    case "$1" in
        dotnet) TARGET="Calc/Calculator.cs"; SNIPPET='    public static int Multiply(int a, int b) => a * b;' ;;
        *) TARGET="src/main/java/demo/Calc.java"; SNIPPET='    public static int multiply(int a, int b) { return a * b; }' ;;
    esac
}

new_repo() { # new_repo <stack> <name> -> REPO (a committed copy of the sample)
    local d="$T/$2"
    mkdir -p "$d"
    REPO="$d/repo"
    cp -R "$SAMPLES/$1" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name stacks
    git -C "$REPO" config user.email stacks@example.invalid
    git -C "$REPO" add -A .
    git -C "$REPO" commit -q -m base
}

# run_loki <stack> <name> <path> [extra env...] -> OUT, RC, RECEIPT (path or empty)
run_loki() {
    local stack="$1" name="$2" path="$3"; shift 3
    sample_target "$stack"
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_TEST_COMMAND \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$path" \
        E2E_STUB_MODE=stack E2E_STUB_TARGET="$TARGET" E2E_STUB_SNIPPET="$SNIPPET" E2E_STUB_LOG="$T/$name/stub.log" \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$T/$name/k.pem" \
        DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_CLI_USE_MSBUILD_SERVER=0 MSBUILDDISABLENODEREUSE=1 UseSharedCompilation=false \
        "$@" ${TO[@]+"${TO[@]}"} "$BASH_BIN" "$ROOT/bin/loki" "$TASK" --no-pr 2>&1)"
    RC=$?
    RECEIPT="$(ls "$REPO"/.loki/runs/*/receipt.json 2>/dev/null | head -1)"
}

outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
tail_out() { printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
receipt_cmds() { [ -n "$RECEIPT" ] && python3 -I -c 'import json,sys; [print(c.get("cmd","")) for c in json.load(open(sys.argv[1])).get("checks",[]) if c.get("result")=="pass"]' "$RECEIPT"; }

expect_verified() { # expect_verified <label> <cmd needle>
    local o; o="$(outcome)"
    if [ "$o" = "VERIFIED" ]; then ok "$1: Outcome VERIFIED"; else bad "$1: Outcome was '${o}' (rc $RC)"; tail_out; fi
    case "$(receipt_cmds)" in *"$2"*) ok "$1: a passing check ran '$2'" ;; *) bad "$1: no passing receipt check ran '$2' (checks: $(receipt_cmds | tr '\n' ';'))" ;; esac
}

expect_missing() { # expect_missing <label> <tool> <install needle>
    local o; o="$(outcome)"
    if [ "$o" != "VERIFIED" ] && [ -n "$o" ]; then ok "$1: not VERIFIED (Outcome $o)"; else bad "$1: Outcome was '${o}'; a missing tool must never verify"; tail_out; fi
    case "$OUT" in *"$2 is not installed"*) ok "$1: output names the missing tool '$2'" ;; *) bad "$1: output does not say '$2 is not installed'"; tail_out ;; esac
    case "$OUT" in *"$3"*) ok "$1: output says how to install ('$3')" ;; *) bad "$1: output has no install hint ('$3')" ;; esac
}

# network_for <stack>: 0 when the registry the real tool needs answers
network_for() {
    local url="https://repo.maven.apache.org/maven2/"
    [ "$1" = dotnet ] && url="https://api.nuget.org/v3/index.json"
    command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null --max-time 8 "$url" 2>/dev/null
}

skip_or_fail() { # skip_or_fail <label> <why>
    if [ "$REQUIRE" = 1 ]; then bad "$1: $2 (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: $1: $2"; fi
}

REALPATH_ENV="$PATH"

# ---------------------------------------------------------------- real tool legs
for spec in maven:mvn gradle:gradle dotnet:dotnet; do
    stack="${spec%%:*}"; tool="${spec##*:}"
    if ! command -v "$tool" >/dev/null 2>&1; then
        skip_or_fail "$stack real tool" "$tool is not on PATH"
    elif ! network_for "$stack"; then
        skip_or_fail "$stack real tool" "$tool is present but its package registry is unreachable"
    else
        new_repo "$stack" "real-$stack"
        run_loki "$stack" "real-$stack" "$FIX/bin:$REALPATH_ENV"
        expect_verified "$stack real $tool" "$tool"
    fi
done

# ---------------------------------------------------------------- tool missing legs
for spec in maven:mvn:Maven gradle:gradle:Gradle dotnet:dotnet:.NET; do
    IFS=: read -r stack tool hint <<< "$spec"
    new_repo "$stack" "missing-$stack"
    run_loki "$stack" "missing-$stack" "$FIX/bin:$CLEAN"
    expect_missing "$stack tool missing" "$tool" "$hint"
done

# ---------------------------------------------------------------- repo wrapper legs
write_wrapper() { # write_wrapper <stack> <file> <log>: a stand-in that insists on the engine's own arguments
    local stack="$1" f="$2" log="$3"
    if [ "$stack" = maven ]; then
        cat > "$f" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$log"
case "\$*" in *"-B test -Dtest=CalcTest"*) ;; *) echo "[ERROR] BUILD FAILURE"; exit 3 ;; esac
echo "[INFO] Running demo.CalcTest"
echo "[INFO] "
echo "[INFO] Results:"
echo "[INFO] "
echo "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0"
echo "[INFO] "
echo "[INFO] BUILD SUCCESS"
EOF
    else
        cat > "$f" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$log"
case "\$*" in *"cleanTest test --tests demo.CalcTest"*) ;; *) echo "BUILD FAILED in 1s"; exit 3 ;; esac
echo "demo.CalcTest > addsTwoNumbers() PASSED"
echo ""
echo "BUILD SUCCESSFUL in 1s"
EOF
    fi
    chmod +x "$f"
}
for spec in maven:mvnw gradle:gradlew; do
    stack="${spec%%:*}"; w="${spec##*:}"
    new_repo "$stack" "wrapper-$stack"
    write_wrapper "$stack" "$REPO/$w" "$T/wrapper-$stack/wrapper.log"
    git -C "$REPO" add "$w"; git -C "$REPO" commit -q -m "add $w"
    run_loki "$stack" "wrapper-$stack" "$FIX/bin:$CLEAN"
    expect_verified "$stack repo wrapper (no $stack on PATH)" "./$w"
    [ -s "$T/wrapper-$stack/wrapper.log" ] && ok "$stack wrapper was invoked by the engine" || bad "$stack wrapper was never invoked"
done

# ---------------------------------------------------------------- committed command leg
new_repo maven "config-maven"
mkdir -p "$REPO/ci"
cat > "$REPO/ci/test.sh" <<EOF
#!/usr/bin/env bash
echo ran >> "$T/config-maven/ci.log"
echo "[INFO] Results:"
echo "[INFO] "
echo "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0"
echo "[INFO] "
echo "[INFO] BUILD SUCCESS"
EOF
printf 'verify:\n  test_command: bash ci/test.sh\n' > "$REPO/loki.yaml"
git -C "$REPO" add ci/test.sh loki.yaml; git -C "$REPO" commit -q -m "committed test command"
run_loki maven "config-maven" "$FIX/bin:$CLEAN"
expect_verified "maven committed verify.test_command" "ci/test.sh"
[ -s "$T/config-maven/ci.log" ] && ok "the committed command ran" || bad "the committed command never ran"

# ---------------------------------------------------------------- dotnet stand-in legs
mkdir -p "$T/fakedotnet-pass" "$T/fakedotnet-fail"
cat > "$T/fakedotnet-pass/dotnet" <<'EOF'
#!/usr/bin/env bash
echo "  Passed Calc.Tests.CalculatorTests.AddsTwoNumbers [2 ms]"
echo ""
echo "Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 4 ms - Calc.Tests.dll (net8.0)"
EOF
cat > "$T/fakedotnet-fail/dotnet" <<'EOF'
#!/usr/bin/env bash
echo "  Failed Calc.Tests.CalculatorTests.AddsTwoNumbers [2 ms]"
echo ""
echo "Failed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1, Duration: 4 ms - Calc.Tests.dll (net8.0)"
exit 1
EOF
chmod +x "$T/fakedotnet-pass/dotnet" "$T/fakedotnet-fail/dotnet"
new_repo dotnet "fake-dotnet-pass"
run_loki dotnet "fake-dotnet-pass" "$T/fakedotnet-pass:$FIX/bin:$CLEAN"
expect_verified "dotnet stand-in reporting a pass" "dotnet test Calc.Tests/Calc.Tests.csproj"
new_repo dotnet "fake-dotnet-fail"
run_loki dotnet "fake-dotnet-fail" "$T/fakedotnet-fail:$FIX/bin:$CLEAN"
o="$(outcome)"
if [ -n "$o" ] && [ "$o" != "VERIFIED" ]; then ok "dotnet stand-in reporting a failure: not VERIFIED (Outcome $o)"; else bad "dotnet stand-in reporting a failure: Outcome was '${o}'"; tail_out; fi

# ---------------------------------------------------------------- parsers and detection
PARSE="$(bun -e '
import { dotnetSummary } from "./loki-ts/src/util/dotnet_test.ts";
import { stackRunner, installHint } from "./loki-ts/src/util/stack_tools.ts";
import { guessRunner, isTestFile } from "./loki-ts/src/util/test_file_text.ts";
const pass = "Passed!  - Failed:     0, Passed:     2, Skipped:     1, Total:     3, Duration: 4 ms - A.dll (net8.0)";
const out: Record<string, unknown> = {
  pass: dotnetSummary(pass),
  fail: dotnetSummary("  Failed N.C.M [1 ms]\nFailed!  - Failed:     1, Passed:     1, Skipped:     0, Total:     2, Duration: 4 ms - A.dll (net8.0)"),
  contradiction: dotnetSummary("Passed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1, Duration: 1 ms - A.dll (net8.0)"),
  badtotal: dotnetSummary("Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     5, Duration: 1 ms - A.dll (net8.0)"),
  zero: dotnetSummary("Passed!  - Failed:     0, Passed:     0, Skipped:     0, Total:     0, Duration: 1 ms - A.dll (net8.0)"),
  none: dotnetSummary("Build succeeded.\n    0 Warning(s)"),
  twoAssemblies: dotnetSummary(pass + "\n" + pass),
  mtp: dotnetSummary("Test run summary: Passed!\n  total: 4\n  failed: 0\n  succeeded: 4\n  skipped: 0\n  duration: 1s"),
  stackMaven: stackRunner(["pom.xml", "src/A.java"]), stackGradle: stackRunner(["build.gradle.kts", "A.java"]), stackDotnet: stackRunner(["src/App.csproj", "A.cs"]), stackNone: stackRunner(["main.rb"]),
  cs: guessRunner("FooTests.cs", ["dotnet"]), csNoRunner: guessRunner("FooTests.cs", ["maven"]),
  isCs: isTestFile("src/FooTests.cs"), isJava: isTestFile("src/test/java/a/FooTest.java"), notTest: isTestFile("src/Foo.cs"),
  hint: installHint("dotnet"),
};
console.log(JSON.stringify(out));
' 2>&1)"
jq_eq() { # jq_eq <label> <json path expr in python> <expected>
    local got; got="$(printf '%s' "$PARSE" | python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); print(json.dumps(eval(sys.argv[1]), sort_keys=True))' "$2" 2>/dev/null)"
    [ "$got" = "$3" ] && ok "parser: $1" || bad "parser: $1 (got '$got', want '$3')"
}
jq_eq "a pass line counts executed tests, not skipped" 'd["pass"]' '{"executed": 2, "failed": 0, "ids": []}'
jq_eq "a failure line counts and names the failing test" 'd["fail"]' '{"executed": 2, "failed": 1, "ids": ["N.C.M"]}'
jq_eq "a Passed! verdict with failures is unmeasured" 'd["contradiction"]' 'null'
jq_eq "a total that does not add up is unmeasured" 'd["badtotal"]' 'null'
jq_eq "zero executed tests is unmeasured" 'd["zero"]' 'null'
jq_eq "no summary is unmeasured" 'd["none"]' 'null'
jq_eq "two assemblies are summed" 'd["twoAssemblies"]["executed"]' '4'
jq_eq "the Microsoft.Testing.Platform summary is read" 'd["mtp"]' '{"executed": 4, "failed": 0, "ids": []}'
jq_eq "maven, gradle, dotnet and none are detected from files" '[d["stackMaven"], d["stackGradle"], d["stackDotnet"], d["stackNone"]]' '["maven", "gradle", "dotnet", null]'
jq_eq "a .cs test gets the dotnet runner only when the repo has it" '[d["cs"], d["csNoRunner"]]' '["dotnet", null]'
jq_eq "C# and Java test files are test files, a source file is not" '[d["isCs"], d["isJava"], d["notTest"]]' '[true, true, false]'
jq_eq "the dotnet install hint names the SDK" '".NET SDK" in d["hint"]' 'true'

finish
