#!/usr/bin/env bash
# The A-004 contract guard must REJECT drift. Mutation proof for
# tests/test-mcp-tool-surface-packaged.sh.
#
# A gate that has only ever been observed passing is not known to be a gate.
# The defect the frozen contract exists for is a SAME-COUNT RENAME: the earlier
# revision derived expectations from the mutable source, so renaming a tool
# moved the expectation with it and 36 == 36 stayed green while the published
# contract broke. Count-based thinking cannot see that mutant. So this asserts,
# by construction, that the guard fails on each of:
#
#   1. same-count rename   (36 -> 36, one name changed)   <- the circularity bug
#   2. deletion            (36 -> 35, one name gone)
#   3. npm unavailable     (prerequisite missing)         <- must not SKIP green
#   4. MCP SDK unavailable (measurement unavailable)      <- must not SKIP green
#   4b. MCP SDK absent but SHADOWED by the repo's own mcp/ <- run 30991330118
#   4c. SDK probe exits nonzero, empty stderr    <- verdict must bind to $?, not stderr
#   4d. SDK probe exits zero, benign stderr      <- nonempty stderr alone must not fail it
#   5. contradictory doc   (a current file states 36 AND 34) <- the false-green
#
# Mutant 5 is the docs-arm analogue of mutant 1. Presence of the correct count
# is not absence of a stale one: the guard's earlier revision checked eight
# surfaces for "36" but residual-scanned only three, so a README carrying both a
# correct "36 tools" and a leftover "34 tools" passed. Like the same-count
# rename, no count-based check can see it -- 36 IS present. It is caught only by
# asserting that nothing OTHER than 36 survives.
#
# Mutants are applied to a COPY of the repo tree, never to the working tree.
# Nothing is installed and nothing hits the network; prerequisite mutants work
# by shadowing PATH / PYTHONPATH, not by removing anything from the host.
#
# ponytail: mutants 1-2 mutate SOURCE only and assert the guard's source-side
# arm fires. That arm runs before npm pack, so these stay fast and need no SDK.
# Mutant 5 targets the LAST arm, so it alone needs a tree that survives the real
# packaged handshake -- see seed_full_tree() for why the sparse seed cannot.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: the packaged MCP contract guard rejects drift (mutation proof)"

GUARD="tests/test-mcp-tool-surface-packaged.sh"
[ -f "$REPO_ROOT/$GUARD" ] || { bad "$GUARD not found -- nothing to mutate"; echo "  Passed: $PASS  Failed: $FAIL"; exit 1; }

WORK="$(mktemp -d -t loki-mcp-mut-XXXX)" || { bad "mktemp failed"; exit 1; }
MAIN_PID=$$
cleanup() { [ "$$" = "$MAIN_PID" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT

# A tool whose name appears in mcp/server.py as a decorated def AND in the
# frozen contract. Chosen explicitly, not scraped, so the mutant is legible.
VICTIM="loki_verify_fast"
grep -q "def ${VICTIM}" "$REPO_ROOT/mcp/server.py" \
    || { bad "mutation target ${VICTIM} not found in mcp/server.py -- test is inert"; echo "  Passed: $PASS  Failed: $FAIL"; exit 1; }
grep -q "^${VICTIM}$" "$REPO_ROOT/$GUARD" \
    || { bad "mutation target ${VICTIM} not in the frozen contract -- test is inert"; echo "  Passed: $PASS  Failed: $FAIL"; exit 1; }

# Copy only what the guard's source-side arm reads. Cheap, and keeps the
# mutant tree obviously isolated from the working tree.
seed_tree() {  # $1 = destination
    local d="$1"
    mkdir -p "$d/mcp" "$d/tests" "$d/tools" "$d/docs/walkthrough" "$d/wiki" || return 1
    cp "$REPO_ROOT/mcp/server.py" "$REPO_ROOT/mcp/magic_tools.py" \
       "$REPO_ROOT/mcp/managed_tools.py" "$d/mcp/" || return 1
    cp "$REPO_ROOT/$GUARD" "$d/tests/" || return 1
    # package.json and every helper its prepack lifecycle invokes. PACKET-376
    # added an exact-inventory permission normalizer to prepack. Copying the
    # manifest without that shipped helper makes npm pack die before the four
    # MCP-prerequisite mutants reach the diagnostics they exist to discriminate.
    # Keep this sparse fixture packable without weakening or bypassing prepack.
    [ -f "$REPO_ROOT/package.json" ] && cp "$REPO_ROOT/package.json" "$d/" || return 1
    cp "$REPO_ROOT/tools/normalize-package-permissions.mjs" "$d/tools/" || return 1
    return 0
}

# Run the guard inside a mutant tree; echo its exit code. The guard cds to its
# own repo root, so running the COPY under $d makes $d the repo root.
run_guard() {  # $1 = tree  [env overrides via caller]
    ( cd "$1" && bash tests/test-mcp-tool-surface-packaged.sh >"$1/out.txt" 2>&1; echo $? )
}

assert_rejects() {  # $1=label  $2=tree  $3=expected-substring
    local label="$1" tree="$2" needle="$3" rc
    rc="$(run_guard "$tree")"
    if [ "$rc" -eq 0 ]; then
        bad "$label: guard exited 0 -- mutant NOT rejected (false green)"
        sed -n '1,12p' "$tree/out.txt" | sed 's/^/    /'
        return 1
    fi
    if ! grep -q "$needle" "$tree/out.txt"; then
        bad "$label: guard exited $rc but never reported '$needle'"
        sed -n '1,12p' "$tree/out.txt" | sed 's/^/    /'
        return 1
    fi
    ok "$label: guard exited $rc and named the defect"
    return 0
}

# --- mutant 1: SAME-COUNT RENAME (36 -> 36) ---------------------------------
# The exact mutant a source-derived expectation cannot catch.
M1="$WORK/m1"; seed_tree "$M1" || { bad "seed m1"; exit 1; }
python3 - "$M1/mcp/server.py" "$VICTIM" <<'PY'
import sys
p, victim = sys.argv[1], sys.argv[2]
s = open(p).read()
assert f"def {victim}" in s
open(p, "w").write(s.replace(f"def {victim}", f"def {victim}_renamed"))
PY
assert_rejects "same-count rename (36 -> 36)" "$M1" "NOT in the frozen contract: ${VICTIM}_renamed"

# The rename must ALSO be reported as the contract name going missing --
# proving the guard compares sets, not sizes.
if grep -q "contract tool MISSING: ${VICTIM}" "$M1/out.txt"; then
    ok "same-count rename: guard also names the vanished contract tool"
else
    bad "same-count rename: guard did not report ${VICTIM} as missing"
fi
# And it must NOT have passed a count check by accident.
if grep -qE "^PASS: source registers exactly" "$M1/out.txt"; then
    bad "same-count rename: guard still claimed the source surface matched"
else
    ok "same-count rename: guard withheld the source-match PASS"
fi

# --- mutant 2: DELETION (36 -> 35) ------------------------------------------
M2="$WORK/m2"; seed_tree "$M2" || { bad "seed m2"; exit 1; }
python3 - "$M2/mcp/server.py" "$VICTIM" <<'PY'
import ast, sys
p, victim = sys.argv[1], sys.argv[2]
src = open(p).read()
lines = src.splitlines(keepends=True)
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == victim:
        start = min([d.lineno for d in node.decorator_list] or [node.lineno]) - 1
        end = node.end_lineno
        # comment the whole def out -- an absent registration, still valid python
        for i in range(start, end):
            lines[i] = "# MUTANT-DELETED " + lines[i]
        break
else:
    sys.exit("victim not found")
open(p, "w").write("".join(lines))
PY
assert_rejects "deletion (36 -> 35)" "$M2" "contract tool MISSING: ${VICTIM}"

# --- mutant 3: npm UNAVAILABLE ----------------------------------------------
# Prerequisite absent. Must fail closed, not SKIP with exit 0.
M3="$WORK/m3"; seed_tree "$M3" || { bad "seed m3"; exit 1; }
NPMSHADOW="$WORK/nonpm"; mkdir -p "$NPMSHADOW"
# A PATH containing only a shim dir: npm is unfindable, but the interpreters the
# guard needs are invoked via absolute paths resolved before the shadow applies.
for need in bash sh env python3 grep sed comm sort wc tr tail head cat mktemp rm tar printf dirname basename; do
    real="$(command -v "$need" 2>/dev/null)" || continue
    ln -sf "$real" "$NPMSHADOW/$need" 2>/dev/null || true
done
M3RC="$( cd "$M3" && PATH="$NPMSHADOW" bash tests/test-mcp-tool-surface-packaged.sh >"$M3/out.txt" 2>&1; echo $? )"
if [ "$M3RC" -ne 0 ] && grep -q "npm unavailable" "$M3/out.txt"; then
    ok "npm unavailable: guard exited $M3RC and failed closed"
else
    bad "npm unavailable: guard exited $M3RC (expected nonzero + 'npm unavailable')"
    sed -n '1,12p' "$M3/out.txt" | sed 's/^/    /'
fi
if grep -qi "^SKIP" "$M3/out.txt"; then
    bad "npm unavailable: guard still emitted a SKIP"
else
    ok "npm unavailable: guard emitted no SKIP"
fi

# --- mutant 4: MCP SDK UNAVAILABLE ------------------------------------------
# Measurement unavailable. Must fail closed, not SKIP with exit 0.
# Shadow the `mcp` module with a package that raises on import, so `import mcp`
# fails without touching the host's site-packages.
M4="$WORK/m4"; seed_tree "$M4" || { bad "seed m4"; exit 1; }
SDKSHADOW="$WORK/nosdk"; mkdir -p "$SDKSHADOW/mcp"
printf 'raise ImportError("MUTANT: MCP SDK unavailable")\n' > "$SDKSHADOW/mcp/__init__.py"
M4RC="$( cd "$M4" && PYTHONPATH="$SDKSHADOW" bash tests/test-mcp-tool-surface-packaged.sh >"$M4/out.txt" 2>&1; echo $? )"
if [ "$M4RC" -ne 0 ] && grep -q "MCP SDK not importable" "$M4/out.txt"; then
    ok "MCP SDK unavailable: guard exited $M4RC and failed closed"
else
    bad "MCP SDK unavailable: guard exited $M4RC (expected nonzero + 'MCP SDK not importable')"
    sed -n '1,20p' "$M4/out.txt" | sed 's/^/    /'
fi
if grep -qi "^SKIP" "$M4/out.txt"; then
    bad "MCP SDK unavailable: guard still emitted a SKIP"
else
    ok "MCP SDK unavailable: guard emitted no SKIP"
fi

# --- mutant 4b: SDK ABSENT, BUT SHADOWED BY THE REPO'S OWN mcp/ PACKAGE ------
# The false-green from GitHub Tests run 30991330118, shards 2/4 and 3/4.
#
# Mutant 4 above shadows `mcp` with a package that RAISES on import, so any
# probe fails. That cannot catch the real defect, where `import mcp` SUCCEEDS
# and binds Loki's own mcp/ (cwd is on sys.path) while ClientSession and
# stdio_client do not exist. The old `python3 -c 'import mcp'` prerequisite
# passed on a CI host with no SDK installed at all, and the guard fell through
# to report "handshake returned NO tools" -- a server defect that was not one.
#
# Reproduced by construction: the mutant tree's own mcp/ is importable and has
# no client symbols, and PYTHONPATH is emptied via a shim that hides any real
# SDK, so `import mcp` from the repo root succeeds and the capability probe
# must still fail. A guard that probes the package NAME false-greens here; one
# that probes the client SYMBOLS from a non-repo cwd fails closed.
M4B="$WORK/m4b"; seed_tree "$M4B" || { bad "seed m4b"; exit 1; }
# Precondition: the seeded tree's mcp/ must be importable-by-name and lack the
# client symbols. Without this the mutant could pass for the wrong reason.
touch "$M4B/mcp/__init__.py"
NOSDK2="$WORK/nosdk2"; mkdir -p "$NOSDK2/mcp"
printf 'raise ImportError("MUTANT: no real MCP SDK on this host")\n' > "$NOSDK2/mcp/__init__.py"
if ( cd "$M4B" && PYTHONPATH="$NOSDK2" python3 -c 'import mcp' >/dev/null 2>&1 ); then
    ok "repo-shadowed SDK: 'import mcp' still SUCCEEDS in the mutant (shadow is real)"
else
    bad "repo-shadowed SDK: mutant did not reproduce the shadow -- test is inert"
fi
M4BRC="$( cd "$M4B" && PYTHONPATH="$NOSDK2" bash tests/test-mcp-tool-surface-packaged.sh >"$M4B/out.txt" 2>&1; echo $? )"
if [ "$M4BRC" -ne 0 ] && grep -q "MCP SDK not importable" "$M4B/out.txt"; then
    ok "repo-shadowed SDK: guard exited $M4BRC and failed closed on the capability probe"
else
    bad "repo-shadowed SDK: guard exited $M4BRC (expected nonzero + 'MCP SDK not importable')"
    sed -n '1,20p' "$M4B/out.txt" | sed 's/^/    /'
fi
# The defect must be named as a PREREQUISITE failure, never as a server-side
# handshake failure. Misattribution is what cost run 30991330118 its diagnosis.
if grep -q "handshake returned NO tools" "$M4B/out.txt"; then
    bad "repo-shadowed SDK: guard blamed the server handshake for a missing prerequisite"
else
    ok "repo-shadowed SDK: guard did not misattribute this to a server handshake failure"
fi

# --- shared shim for mutants 4c/4d: a PATH python3 that discriminates the ----
# SDK capability probe (PYSDK) by its exact stdin content and delegates every
# other invocation -- the SOURCE derivation and the PYHS handshake -- to the
# real interpreter. Deterministic and host-independent: the verdict direction
# is fixed by the shim, not by whether this machine happens to have the SDK.
REAL_PYTHON3="$(command -v python3)" || { bad "no real python3 on PATH -- cannot build shim"; echo "  Passed: $PASS  Failed: $FAIL"; exit 1; }
make_sdk_probe_shim() {  # $1 = shim dir  $2 = probe-rc  $3 = probe-stderr (may be empty)
    local dir="$1" rc="$2" err="$3"
    mkdir -p "$dir" || return 1
    cat > "$dir/python3" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = "-" ]; then
    IN="\$(cat)"
    case "\$IN" in
        *"from mcp import ClientSession, StdioServerParameters"*"from mcp.client.stdio import stdio_client"*)
            printf '%s' "$err" >&2
            exit $rc
            ;;
    esac
    printf '%s' "\$IN" | exec "$REAL_PYTHON3" "\$@"
fi
exec "$REAL_PYTHON3" "\$@"
SHIM
    chmod +x "$dir/python3"
}

# --- mutant 4c: SDK PROBE EXITS NONZERO, STDERR EMPTY ------------------------
# The verdict must bind to the exit status alone. A probe that fails silently
# (exit nonzero, nothing on stderr) is the case a stderr-keyed check gets
# backwards in the fail direction: `[ -n "$SDK_ERR" ]` would stay false and
# let a genuinely broken prerequisite through as satisfied.
M4C="$WORK/m4c"; seed_tree "$M4C" || { bad "seed m4c"; exit 1; }
SHIM4C="$WORK/shim4c"; make_sdk_probe_shim "$SHIM4C" 1 "" || { bad "build shim4c"; exit 1; }
M4CRC="$( cd "$M4C" && PATH="$SHIM4C:$PATH" bash tests/test-mcp-tool-surface-packaged.sh >"$M4C/out.txt" 2>&1; echo $? )"
if [ "$M4CRC" -ne 0 ] && grep -q "MCP SDK not importable (probe exit 1)" "$M4C/out.txt"; then
    ok "SDK probe nonzero/empty stderr: guard exited $M4CRC and named the nonzero probe exit"
else
    bad "SDK probe nonzero/empty stderr: guard exited $M4CRC (expected nonzero + 'probe exit 1')"
    sed -n '1,20p' "$M4C/out.txt" | sed 's/^/    /'
fi
if grep -q "handshake returned NO tools" "$M4C/out.txt"; then
    bad "SDK probe nonzero/empty stderr: guard blamed the handshake instead of the prerequisite"
else
    ok "SDK probe nonzero/empty stderr: guard did not misattribute this to a handshake failure"
fi

# --- mutant 4d: SDK PROBE EXITS ZERO, STDERR NONEMPTY (benign warning) -------
# The other direction of the same bug: a satisfied prerequisite that happens to
# print something benign (e.g. a DeprecationWarning) to stderr must not be
# rejected as "MCP SDK not importable" merely because stderr is nonempty. The
# shim's real handshake (PYHS) is left to the genuine interpreter, so with no
# real SDK on this host it fails later at the handshake -- proving the guard
# passed the prerequisite arm rather than never reaching it.
M4D="$WORK/m4d"; seed_tree "$M4D" || { bad "seed m4d"; exit 1; }
SHIM4D="$WORK/shim4d"; make_sdk_probe_shim "$SHIM4D" 0 "DeprecationWarning: benign, ignore me" || { bad "build shim4d"; exit 1; }
M4DRC="$( cd "$M4D" && PATH="$SHIM4D:$PATH" bash tests/test-mcp-tool-surface-packaged.sh >"$M4D/out.txt" 2>&1; echo $? )"
if grep -q "MCP SDK not importable" "$M4D/out.txt"; then
    bad "SDK probe zero/benign stderr: guard rejected the prerequisite on stderr alone"
    sed -n '1,20p' "$M4D/out.txt" | sed 's/^/    /'
else
    ok "SDK probe zero/benign stderr: guard did not reject on nonempty stderr"
fi
if grep -q "^PASS: MCP SDK client capabilities importable from a non-repo cwd" "$M4D/out.txt"; then
    ok "SDK probe zero/benign stderr: guard recorded the prerequisite PASS despite stderr"
else
    bad "SDK probe zero/benign stderr: guard never reached the prerequisite PASS"
    sed -n '1,20p' "$M4D/out.txt" | sed 's/^/    /'
fi
[ "$M4DRC" -ne 0 ] || bad "SDK probe zero/benign stderr: guard exited 0 -- expected a later, different failure"

# --- mutant 5: CONTRADICTORY DOCUMENT (a current surface states 36 AND 34) ---
# The docs arm is the guard's LAST section, so this mutant must survive sections
# 0-4 to reach it: the frozen contract, the source AST scan, `npm pack`, and a
# real initialize -> tools/list handshake against the packaged server.py.
#
# The sparse seed_tree() above CANNOT do that -- measured: it dies at "packaged
# MCP handshake returned NO tools", because three copied mcp/*.py files are not
# an importable package tree. A mutant that exits nonzero for that reason would
# "prove" nothing about the docs arm. So seed from the EXTRACTED TARBALL, which
# is by construction the complete tree the guard's own section 3 handshakes
# against, and add the nine current doc surfaces.
#
# The nine are copied from the repo, not taken from the tarball, because only
# README.md and docs/WANG-PRINCIPLES-PLAN.md ship in files[] -- the other seven
# are absent from the package, and without them the guard would die on
# "wiki/Home.md is missing", an earlier unrelated failure. This is a bounded,
# deterministic copy of a fixed list: no network, no writes outside $WORK.
seed_full_tree() {  # $1 = destination dir; leaves the tree at $1/package
    local d="$1" tb
    mkdir -p "$d" || return 1
    tb="$(cd "$REPO_ROOT" && npm pack --pack-destination "$d" 2>/dev/null | tail -1)"
    [ -n "$tb" ] && [ -f "$d/$tb" ] || return 1
    tar xzf "$d/$tb" -C "$d" || return 1
    [ -d "$d/package" ] || return 1
    # The guard under review, not whatever copy the tarball carried: this test
    # must exercise the candidate in tests/, which files[] does not ship.
    mkdir -p "$d/package/tests" || return 1
    cp "$REPO_ROOT/$GUARD" "$d/package/tests/" || return 1
    local f
    for f in README.md wiki/Home.md wiki/CLI-Reference.md server.json COMPONENTS.md \
             CLAUDE.md docs/walkthrough/architecture.html \
             docs/walkthrough/comparison.html docs/WANG-PRINCIPLES-PLAN.md; do
        mkdir -p "$d/package/$(dirname "$f")" || return 1
        cp "$REPO_ROOT/$f" "$d/package/$f" || return 1
    done
    return 0
}

M5="$WORK/m5"
if ! seed_full_tree "$M5"; then
    bad "contradictory doc: could not seed a packaged tree (npm pack/extract failed)"
else
    M5T="$M5/package"
    # Append a stale count to an otherwise VALID current README. The correct
    # "36 tools" line is left intact, so the presence check still passes and the
    # only thing that can fail is the residual scan.
    printf '\nThe MCP server exposes 34 tools over stdio.\n' >> "$M5T/README.md"

    M5RC="$( cd "$M5T" && bash tests/test-mcp-tool-surface-packaged.sh >"$M5T/out.txt" 2>&1; echo $? )"

    # Proof of ARRIVAL at the docs arm. Without this, any nonzero exit for any
    # unrelated reason would satisfy the rejection assertion below.
    if grep -qE "^PASS: README\.md states the frozen tool count \(36\)" "$M5T/out.txt"; then
        ok "contradictory doc: guard reached the docs arm (36 still present in README)"
    else
        bad "contradictory doc: guard never reached the docs arm -- unrelated earlier failure"
        tail -12 "$M5T/out.txt" | sed 's/^/    /'
    fi

    # Proof of REJECTION, naming the stale count.
    if [ "$M5RC" -ne 0 ] && grep -q "README.md states a tool count other than the frozen 36" "$M5T/out.txt"; then
        ok "contradictory doc: guard exited $M5RC and named the stale count"
    else
        bad "contradictory doc: guard exited $M5RC (expected nonzero + stale-count report)"
        tail -12 "$M5T/out.txt" | sed 's/^/    /'
    fi

    # The stale line itself must be quoted back, so a reader is told WHICH line.
    if grep -q "34 tools" "$M5T/out.txt"; then
        ok "contradictory doc: guard quoted the offending 34-tool line"
    else
        bad "contradictory doc: guard reported drift without quoting the stale line"
    fi

    # ISOLATION: the injected stale count must be the ONLY failure. README.md is
    # first in CURRENT_SURFACES, so its two assertions fire before the loop can
    # reach any later surface -- a seed missing wiki/Home.md would still produce
    # the arrival PASS and the stale-count FAIL, and the mutant would look green
    # while actually dying on "wiki/Home.md is missing". Asserting a failure
    # COUNT of exactly 1 is what makes this mutant a single-defect proof: it
    # fails if the seed is incomplete, if a `die` fired, or if any other surface
    # regressed. (Counting is sound here -- this is the mutant's OWN evidence,
    # not the contract surface, and every failure line is enumerated below.)
    M5FAILS="$(grep -c '^FAIL:' "$M5T/out.txt" | tr -d ' ')"
    if [ "$M5FAILS" = "1" ]; then
        ok "contradictory doc: the stale count was the ONLY failure (seed complete, no earlier die)"
    else
        bad "contradictory doc: expected exactly 1 FAIL, got $M5FAILS -- mutant is not isolated"
        grep '^FAIL:' "$M5T/out.txt" | sed 's/^/    /'
    fi

    # And every OTHER current surface must still have passed both arms, so the
    # refactored one-list/two-assertion loop is exercised in full by this mutant.
    if grep -q "^PASS: docs/WANG-PRINCIPLES-PLAN.md states no tool count other than the frozen 36" "$M5T/out.txt"; then
        ok "contradictory doc: the loop ran to the last surface (all 9 checked)"
    else
        bad "contradictory doc: the loop did not reach the last surface"
    fi
fi

echo "  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
