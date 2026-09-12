#!/usr/bin/env bash
# tests/cli/test-quickstart-brownfield.sh
# Test: quickstart must not do the OPPOSITE of what the user asked.
#
# The reproduced founder bug: a user ran `loki quickstart` inside an EXISTING
# app directory, typed "update color theme of application to mimic meta", was
# offered three greenfield templates, typed "none" -- and quickstart built a
# todo app anyway and wrote ./prd.md into their project.
#
# Two root causes, both asserted here by DRIVING THE REAL SCRIPT end to end
# with piped stdin (never by grepping source text):
#   1. the template picker's `*)` arm mapped any unrecognized answer, "none"
#      included, onto the default template, so an explicit rejection became a
#      selection;
#   2. there was zero brownfield detection, so a change request against an
#      existing codebase was treated as a greenfield create request.
#
# The harness mirrors tests/cli/test-quickstart.sh: source quickstart.sh with
# the interactive predicate overridden and the build boundary stubbed, so the
# whole interview runs from piped stdin with ZERO spend and ZERO real build.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
QS="$REPO_ROOT/autonomy/quickstart.sh"

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/loki-qs-brownfield.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

TIMEOUT_BIN=""
for t in timeout gtimeout; do
    if command -v "$t" >/dev/null 2>&1; then TIMEOUT_BIN="$(command -v "$t")"; break; fi
done
run_to() {
    local secs="$1"; shift
    if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$secs" "$@"; else "$@"; fi
}

# make_harness <cwd> [extra]: sources quickstart for real with the interactive
# predicate forced ON and the boundaries stubbed. cmd_start records its argv so
# we can prove WHICH spec the build was started from.
make_harness() {
    local cwd="$1"; local extra="${2:-}"
    cat > "$cwd/harness.sh" <<EOF
#!/usr/bin/env bash
set -uo pipefail
export SKILL_DIR="$REPO_ROOT"
export NO_COLOR=1
show_prd_plan() { printf '%s' '{"cost":{"total_usd":0.40},"time":{"estimated":"14 minutes"},"iterations":{"estimated":4,"range":[3,5]},"complexity":{"tier":"simple"}}'; }
source "$QS"
_qs_non_interactive() { return 1; }
provider_offer_gate() { return 0; }
detect_any_provider() { return 0; }
_qs_selected_provider() { printf 'claude'; }
# No provider call by default: the offline path must be what runs unless a
# test explicitly installs a classifier stub.
_qs_classify_invoke() { return 1; }
cmd_start() { printf '%s\n' "\$*" > "\$PWD/cmd_start.log"; return 0; }
$extra
EOF
}

echo "========================================"
echo "Quickstart Brownfield / Rejection Tests"
echo "========================================"
echo ""

if [ ! -f "$QS" ]; then
    fail "fixture" "autonomy/quickstart.sh not found at $QS"
    echo "Results: $PASS passed, $FAIL failed"; exit 1
fi
pass "fixture: quickstart.sh present"

# ---------------------------------------------------------------------------
# 1. THE FOUNDER TRANSCRIPT. An existing app dir + a change request must NOT
#    offer greenfield templates and must NOT write prd.md into the project.
# ---------------------------------------------------------------------------
T1="$TMP/t1"; mkdir -p "$T1"
printf '{"name":"existing-app"}\n' > "$T1/package.json"
make_harness "$T1"
printf 'printf %s | cmd_quickstart\n' "'update color theme of application to mimic meta\\n\\n'" >> "$T1/harness.sh"
(cd "$T1" && run_to 20 bash ./harness.sh > out.txt 2>&1)
rc=$?
out="$(cat "$T1/out.txt" 2>/dev/null)"

if [ -z "$out" ]; then
    fail "founder transcript: captured output" "output was empty (vacuous assertions would follow)"
else
    pass "founder transcript: captured non-empty output"

    ok=true; why=""
    # Assert each required thing individually, never a count.
    grep -q 'Detected an existing project' "$T1/out.txt" || { ok=false; why="no brownfield notice"; }
    grep -q 'not a new build' "$T1/out.txt" || { ok=false; why="$why; no change framing"; }
    grep -q 'Pick a starting template' "$T1/out.txt" && { ok=false; why="$why; greenfield picker was offered"; }
    grep -q 'simple-todo-app' "$T1/out.txt" && { ok=false; why="$why; a todo template appeared"; }
    if [ "$ok" = true ]; then
        pass "founder transcript: brownfield detected, no greenfield templates offered"
    else
        fail "founder transcript: brownfield" "$why"
    fi

    if [ -e "$T1/prd.md" ]; then
        fail "founder transcript: no unrequested write" "prd.md was written into the existing project"
    else
        pass "founder transcript: no prd.md written into the existing project"
    fi

    # The build must start from a CHANGE-REQUEST spec carrying the user's words,
    # not from a todo template.
    if [ ! -s "$T1/cmd_start.log" ]; then
        fail "founder transcript: build started" "cmd_start was never invoked (rc=$rc)"
    else
        spec="$(awk '{print $1}' "$T1/cmd_start.log")"
        # The framing must MATCH THE SITUATION, not merely mention "existing".
        # The earlier version of this block asserted `grep -qi existing`, which
        # an inverted body ("Replace anything existing") satisfies just as well
        # as the correct one. Assert the decisive sentences individually.
        if [ -z "$spec" ] || [ ! -s "$spec" ]; then
            fail "founder transcript: spec content" "spec=$spec is missing or empty (negative assertions would be vacuous)"
        else
            ok=true; why=""
            grep -q 'mimic meta' "$spec" || { ok=false; why="brief missing"; }
            grep -q 'Change Request' "$spec" || { ok=false; why="$why; not titled a change request"; }
            grep -q 'EXISTING codebase' "$spec" || { ok=false; why="$why; no existing-codebase framing"; }
            grep -q 'Do NOT scaffold a new project' "$spec" || { ok=false; why="$why; missing the do-not-scaffold instruction"; }
            # The inverse framing must be ABSENT on this path.
            grep -q 'This is a NEW project' "$spec" && { ok=false; why="$why; new-project framing leaked into a change request"; }
            grep -qi 'todo' "$spec" && { ok=false; why="$why; a todo template leaked in"; }
            if [ "$ok" = true ]; then
                pass "founder transcript: change-request spec carries existing-codebase framing and the user's words"
            else
                fail "founder transcript: spec content" "spec=$spec: $why"
            fi
        fi

        # The staged spec must have a UNIQUE name. BSD mktemp does not
        # substitute an X-run followed by a suffix, so `foo.XXXXXX.md` yields
        # the LITERAL "foo.XXXXXX.md" -- a fixed path that makes a second
        # concurrent quickstart fail to stage and never start a build. Assert
        # the X-run was really replaced, not merely that the name ends in .md.
        case "$spec" in
            *XXXXXX*) fail "staged spec is unique" "mktemp left a literal X-run in $spec";;
            *) pass "staged spec name is unique (mktemp X-run substituted)";;
        esac
        # And the extension is what routes it through cmd_start's PRD guards.
        case "$spec" in
            *.md) pass "staged spec carries the .md extension cmd_start classifies on";;
            *) fail "staged spec extension" "spec=$spec is not .md";;
        esac
    fi
fi

# ---------------------------------------------------------------------------
# 2. Typing "none" must NOT select a template. Greenfield dir so the picker is
#    genuinely reached; the rejection is the only thing under test.
# ---------------------------------------------------------------------------
for answer in none no skip q; do
    TD="$TMP/none-$answer"; mkdir -p "$TD"
    make_harness "$TD"
    printf 'printf %s | cmd_quickstart\n' "'a bright red analytics dashboard\\n$answer\\n\\n'" >> "$TD/harness.sh"
    (cd "$TD" && run_to 20 bash ./harness.sh > out.txt 2>&1)
    o="$(cat "$TD/out.txt" 2>/dev/null)"
    if [ -z "$o" ]; then
        fail "rejection '$answer': captured output" "output was empty"
        continue
    fi
    if [ ! -s "$TD/cmd_start.log" ]; then
        fail "rejection '$answer'" "cmd_start never ran"
        continue
    fi
    spec="$(awk '{print $1}' "$TD/cmd_start.log")"
    ok=true; why=""
    grep -q 'No template' "$TD/out.txt" || { ok=false; why="no 'No template' notice"; }
    # The decisive assertion: the started spec must not be a shipped template.
    case "$spec" in
        */templates/*) ok=false; why="$why; a shipped template was selected anyway";;
    esac
    # Vacuity guard: every negative assertion below is free on a missing or
    # empty spec, so prove the file has content BEFORE running any of them.
    if [ -z "$spec" ] || [ ! -s "$spec" ]; then
        ok=false; why="$why; spec is missing or empty"
    else
        grep -q 'analytics dashboard' "$spec" || { ok=false; why="$why; spec lost the brief"; }
        # This directory is EMPTY. A rejection here is a request for a new
        # project with no template, so the spec must say so -- and must NOT
        # carry the existing-codebase framing that tells the build to leave the
        # app alone and scaffold nothing. That inversion was the live defect.
        grep -q 'This is a NEW project' "$spec" || { ok=false; why="$why; no new-project framing"; }
        grep -q 'Scaffold the new application' "$spec" || { ok=false; why="$why; no scaffold instruction"; }
        grep -q 'Do NOT scaffold a new project' "$spec" && { ok=false; why="$why; told NOT to scaffold the app the user just asked for"; }
        grep -q 'EXISTING codebase' "$spec" && { ok=false; why="$why; existing-codebase framing in an empty directory"; }
    fi
    if [ "$ok" = true ]; then
        pass "rejection '$answer' is honored: no template selected, brief used as the spec"
    else
        fail "rejection '$answer'" "$why"
    fi
done

# ---------------------------------------------------------------------------
# 3. Rejecting with NO description must refuse, not invent or fall back.
# ---------------------------------------------------------------------------
T3="$TMP/t3"; mkdir -p "$T3"
make_harness "$T3"
printf 'printf %s | cmd_quickstart\n' "'\\nnone\\n\\n'" >> "$T3/harness.sh"
(cd "$T3" && run_to 20 bash ./harness.sh > out.txt 2>&1); rc=$?
if [ "$rc" -eq 2 ] && grep -q 'nothing to build' "$T3/out.txt" && [ ! -e "$T3/cmd_start.log" ] && [ ! -e "$T3/prd.md" ]; then
    pass "rejection with no description refuses (exit 2), starts nothing, writes nothing"
else
    fail "rejection with no description" "rc=$rc, or it built/wrote something anyway"
fi

# ---------------------------------------------------------------------------
# 4. NO REGRESSION: an empty directory still gets the greenfield template flow.
# ---------------------------------------------------------------------------
T4="$TMP/t4"; mkdir -p "$T4"
make_harness "$T4"
printf 'printf %s | cmd_quickstart\n' "'a todo app with user accounts\\n\\n\\n'" >> "$T4/harness.sh"
(cd "$T4" && run_to 20 bash ./harness.sh > out.txt 2>&1)
o="$(cat "$T4/out.txt" 2>/dev/null)"
if [ -z "$o" ]; then
    fail "greenfield regression: captured output" "output was empty"
else
    ok=true; why=""
    grep -q 'Pick a starting template' "$T4/out.txt" || { ok=false; why="picker not offered"; }
    grep -q 'Detected an existing project' "$T4/out.txt" && { ok=false; why="$why; falsely called brownfield"; }
    [ -f "$T4/prd.md" ] || { ok=false; why="$why; prd.md not written"; }
    if [ -s "$T4/cmd_start.log" ]; then
        grep -q 'prd.md' "$T4/cmd_start.log" || { ok=false; why="$why; cmd_start did not get prd.md"; }
    else
        ok=false; why="$why; cmd_start never ran"
    fi
    if [ "$ok" = true ]; then
        pass "greenfield regression: empty dir still offers templates and writes ./prd.md"
    else
        fail "greenfield regression" "$why"
    fi
fi

# ---------------------------------------------------------------------------
# 5. A git repo WITH commits is brownfield; `git init` alone is NOT.
#    A brand-new build legitimately starts in a freshly-initialized folder.
# ---------------------------------------------------------------------------
T5="$TMP/t5"; mkdir -p "$T5"
( cd "$T5" && git init -q . && git config user.email t@example.com && git config user.name t \
  && printf 'hello\n' > app.js && git add app.js && git commit -qm init ) >/dev/null 2>&1
make_harness "$T5"
printf 'printf %s | cmd_quickstart\n' "'change the button colors\\n\\n'" >> "$T5/harness.sh"
(cd "$T5" && run_to 20 bash ./harness.sh > out.txt 2>&1)
if grep -q 'Detected an existing project' "$T5/out.txt" && grep -q 'git repo' "$T5/out.txt" && [ ! -e "$T5/prd.md" ]; then
    pass "git repo with commits is brownfield and writes no prd.md"
else
    fail "git repo with commits" "not detected as brownfield"
fi

T5B="$TMP/t5b"; mkdir -p "$T5B"
( cd "$T5B" && git init -q . ) >/dev/null 2>&1
make_harness "$T5B"
printf 'printf %s | cmd_quickstart\n' "'a todo app\\n\\n\\n'" >> "$T5B/harness.sh"
(cd "$T5B" && run_to 20 bash ./harness.sh > out.txt 2>&1)
if grep -q 'Pick a starting template' "$T5B/out.txt" && ! grep -q 'Detected an existing project' "$T5B/out.txt"; then
    pass "git init with no commits stays greenfield (first build is not blocked)"
else
    fail "empty git init" "an uncommitted git init was treated as an existing project"
fi

# ---------------------------------------------------------------------------
# 6. GRACEFUL DEGRADATION. With a minimal PATH holding NO provider binary, the
#    offline flow must still complete. This is the assertion that quickstart --
#    the first command a new user runs -- never hangs or hard-fails.
# ---------------------------------------------------------------------------
STUB="$TMP/stubbin"; mkdir -p "$STUB"
# Resolve REAL binaries. `command -v` under an interactive shell can return
# alias text ("alias cat='bat --paging=never'") or a bare unresolved name, and
# symlinking either produces a PATH that looks populated but cannot execute.
# `bash` must be here too, or the harness cannot even start and the test would
# report a 127 that has nothing to do with the product.
for b in bash cat awk sed grep basename dirname ls tr sort head cut mktemp shasum rm cp git python3 date wc find chmod sleep uname id; do
    src=""
    for d in /bin /usr/bin /usr/local/bin /opt/homebrew/bin; do
        if [ -x "$d/$b" ]; then src="$d/$b"; break; fi
    done
    [ -n "$src" ] && ln -sf "$src" "$STUB/$b" 2>/dev/null
done
if [ ! -x "$STUB/awk" ] || [ ! -x "$STUB/bash" ]; then
    fail "degradation fixture" "could not build a minimal stub PATH"
else
    # Positive control: the stub PATH really has NO provider binary on it.
    if PATH="$STUB" command -v claude >/dev/null 2>&1; then
        fail "degradation fixture" "claude is visible on the stub PATH; the test would be vacuous"
    else
        pass "degradation fixture: stub PATH contains no provider binary (positive control)"

        T6="$TMP/t6"; mkdir -p "$T6"
        printf '{"name":"x"}\n' > "$T6/package.json"
        # Note: _qs_classify_invoke is NOT stubbed away here; the real one runs
        # and must fail closed because no claude binary exists on this PATH.
        make_harness "$T6" 'unset -f _qs_classify_invoke'
        printf 'printf %s | cmd_quickstart\n' "'restyle the header\\n\\n'" >> "$T6/harness.sh"
        (cd "$T6" && PATH="$STUB" run_to 30 bash ./harness.sh > out.txt 2>&1); rc=$?
        if [ "$rc" -eq 0 ] && grep -q 'Detected an existing project' "$T6/out.txt" && [ -s "$T6/cmd_start.log" ]; then
            pass "no provider on PATH: offline flow still completes and starts the build"
        else
            fail "graceful degradation" "rc=$rc with no provider; flow did not complete offline"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# 7. The model classifier, when present, can OVERRIDE the filesystem verdict:
#    "build a brand new X" typed inside an existing repo is still a new build.
# ---------------------------------------------------------------------------
T7="$TMP/t7"; mkdir -p "$T7"
printf '{"name":"x"}\n' > "$T7/package.json"
make_harness "$T7" '_qs_classify_invoke() { printf "new_project"; }'
printf 'printf %s | cmd_quickstart\n' "'build a brand new todo app from scratch\\n\\n\\n'" >> "$T7/harness.sh"
(cd "$T7" && run_to 20 bash ./harness.sh > out.txt 2>&1)
if grep -q 'Pick a starting template' "$T7/out.txt"; then
    pass "model classifying new_project overrides brownfield and offers templates"
else
    fail "classifier override" "new_project verdict did not restore the greenfield flow"
fi

# A garbage / chatty model answer must NOT be trusted; it falls back to the
# deterministic filesystem verdict rather than guessing.
T8="$TMP/t8"; mkdir -p "$T8"
printf '{"name":"x"}\n' > "$T8/package.json"
make_harness "$T8" '_qs_classify_invoke() { printf "I am not sure, perhaps?"; }'
printf 'printf %s | cmd_quickstart\n' "'restyle the header\\n\\n'" >> "$T8/harness.sh"
(cd "$T8" && run_to 20 bash ./harness.sh > out.txt 2>&1)
if grep -q 'Detected an existing project' "$T8/out.txt" && ! grep -q 'Pick a starting template' "$T8/out.txt"; then
    pass "unparseable model answer falls back to the deterministic brownfield verdict"
else
    fail "classifier fallback" "a garbage model answer changed the verdict"
fi

# ---------------------------------------------------------------------------
# 8. --dry-run must never reach the provider and must keep its template preview.
# ---------------------------------------------------------------------------
T9="$TMP/t9"; mkdir -p "$T9"
printf '{"name":"x"}\n' > "$T9/package.json"
make_harness "$T9" '_qs_classify_invoke() { printf classifier-called > "$PWD/classifier-called"; printf "change_to_existing_code"; }'
printf 'cmd_quickstart "a todo app" --dry-run </dev/null\n' >> "$T9/harness.sh"
(cd "$T9" && run_to 20 bash ./harness.sh > out.txt 2>&1); rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$T9/classifier-called" ] && [ ! -e "$T9/prd.md" ] && [ ! -e "$T9/cmd_start.log" ]; then
    pass "--dry-run in an existing project runs no provider, writes nothing, starts nothing"
else
    fail "--dry-run isolation" "rc=$rc, or the preview path crossed a provider/write boundary"
fi

# ---------------------------------------------------------------------------
# 9. An explicit --template beats brownfield detection: the user was specific.
# ---------------------------------------------------------------------------
T10="$TMP/t10"; mkdir -p "$T10"
printf '{"name":"x"}\n' > "$T10/package.json"
make_harness "$T10"
printf 'printf %s | cmd_quickstart "a dashboard" --template dashboard\n' "'\\n'" >> "$T10/harness.sh"
(cd "$T10" && run_to 20 bash ./harness.sh > out.txt 2>&1)
if grep -q 'Selected dashboard (--template)' "$T10/out.txt" && ! grep -q 'Detected an existing project' "$T10/out.txt"; then
    pass "explicit --template overrides brownfield detection"
else
    fail "--template precedence" "an explicit template choice was overridden by detection"
fi

# ---------------------------------------------------------------------------
# 10. The classifier-override path ALSO reaches the rejection arm. A brownfield
#     dir + "build a brand new X" + "none" offers the picker (greenfield), so
#     the spec must carry new-project framing. $brownfield_reason is still
#     populated here, so any fix that branches on it regresses exactly this
#     case -- which is why the mode is set explicitly at each decision site.
# ---------------------------------------------------------------------------
T11="$TMP/t11"; mkdir -p "$T11"
printf '{"name":"x"}\n' > "$T11/package.json"
make_harness "$T11" '_qs_classify_invoke() { printf "new_project"; }'
printf 'printf %s | cmd_quickstart\n' "'build a brand new todo app from scratch\\nnone\\n\\n'" >> "$T11/harness.sh"
(cd "$T11" && run_to 20 bash ./harness.sh > out.txt 2>&1)
if [ ! -s "$T11/cmd_start.log" ]; then
    fail "classifier-override + rejection" "cmd_start never ran"
else
    spec="$(awk '{print $1}' "$T11/cmd_start.log")"
    if [ -z "$spec" ] || [ ! -s "$spec" ]; then
        fail "classifier-override + rejection" "spec=$spec is missing or empty"
    else
        ok=true; why=""
        grep -q 'This is a NEW project' "$spec" || { ok=false; why="no new-project framing"; }
        grep -q 'Do NOT scaffold a new project' "$spec" && { ok=false; why="$why; stale brownfield framing on a new build"; }
        grep -q 'EXISTING codebase' "$spec" && { ok=false; why="$why; stale existing-codebase framing on a new build"; }
        if [ "$ok" = true ]; then
            pass "classifier override + rejection gets new-project framing (no stale brownfield_reason)"
        else
            fail "classifier-override + rejection" "$why"
        fi
    fi
fi

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
