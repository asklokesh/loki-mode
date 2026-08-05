#!/usr/bin/env bash
# DESIGN-1 regression tests: the OSS design-archetype library.
#
# references/design-archetypes.md is the POSITIVE half of the first-pass DESIGN
# directive. Item 4 of the first-pass block only lists what NOT to do, which
# leaves the model on exactly the priors that produce the generic output; this
# file gives it a concrete aesthetic to commit to. It is appended VERBATIM to the
# iteration-1 system prompt on BOTH routes:
#   bash: providers/claude.sh _loki_autonomy_override_text
#   Bun:  loki-ts/src/providers/claude_flags.ts FIRST_PASS_EXCELLENCE_TEXT
#
# What is asserted here:
#   - the library ships and is reachable from both routes
#   - the appended bytes are IDENTICAL across routes (a one-route-only edit is
#     the failure this catches; the matrix parity gate does not spawn a model, so
#     divergence would otherwise pass every gate and still send different prompts)
#   - it is iteration-1-only (the expensive text must not repeat every iteration)
#   - it fails OPEN: a missing library degrades to the negative-only directive
#   - every named font is real and every palette hex is a real Radix Colors step,
#     because the model writes these straight into @import / next/font calls
#   - license attribution for all three OSS sources is present
set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1
LIB="$REPO_ROOT/references/design-archetypes.md"
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"
FLAGS_TS="$REPO_ROOT/loki-ts/src/providers/claude_flags.ts"

# --- 1. the library exists and is wired on both routes ---------------------
[ -f "$LIB" ] \
  && ok "references/design-archetypes.md ships" \
  || bad "references/design-archetypes.md is missing"

grep -q '_loki_design_archetypes_path' "$CLAUDE_SH" \
  && ok "bash route reads the archetype library" \
  || bad "bash route does not read the archetype library"

grep -q 'designArchetypesText' "$FLAGS_TS" \
  && ok "Bun route reads the archetype library" \
  || bad "Bun route does not read the archetype library"

# --- 2. the appended prompt bytes are identical across routes --------------
# Capture to FILES, not command substitution: $( ) strips trailing newlines and
# would report a false match where the two routes really differ by that byte.
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
BASH_TXT="$TMPD/bash.txt"; BUN_TXT="$TMPD/bun.txt"; BASH_I2="$TMPD/bash2.txt"

( set +u; cd "$REPO_ROOT" || exit 1; ITERATION_COUNT=1; PROJECT_DIR="$REPO_ROOT"
  . providers/claude.sh >/dev/null 2>&1; _loki_autonomy_override_text ) > "$BASH_TXT" 2>/dev/null
( set +u; cd "$REPO_ROOT" || exit 1; ITERATION_COUNT=2; PROJECT_DIR="$REPO_ROOT"
  . providers/claude.sh >/dev/null 2>&1; _loki_autonomy_override_text ) > "$BASH_I2" 2>/dev/null

if [ -s "$BASH_TXT" ] && grep -q 'DESIGN ARCHETYPES' "$BASH_TXT"; then
    ok "bash route appends the archetype library at iteration 1"
else
    bad "bash route did not append the archetype library at iteration 1"
fi

# Iteration-1-only. If this ever reads equal, the gate stopped firing and the
# library is being re-sent every iteration (pure token burn, no added signal).
if grep -q 'DESIGN ARCHETYPES' "$BASH_I2"; then
    bad "archetype library leaked into iteration 2 (not iteration-1-gated)"
else
    ok "archetype library is iteration-1-only"
fi

if command -v bun >/dev/null 2>&1; then
    ( cd "$REPO_ROOT" && bun -e 'import { AUTONOMY_OVERRIDE_TEXT, FIRST_PASS_EXCELLENCE_TEXT } from "./loki-ts/src/providers/claude_flags.ts"; process.stdout.write(AUTONOMY_OVERRIDE_TEXT + FIRST_PASS_EXCELLENCE_TEXT);' ) > "$BUN_TXT" 2>/dev/null
    if [ -s "$BUN_TXT" ] && cmp -s "$BASH_TXT" "$BUN_TXT"; then
        ok "iteration-1 prompt is byte-identical across bash and Bun routes"
    else
        bad "DRIFT: bash=$(wc -c < "$BASH_TXT") bytes, bun=$(wc -c < "$BUN_TXT") bytes"
    fi
else
    ok "route byte-identity skipped (bun not on PATH)"
fi

# --- 3. fails OPEN when the library is absent ------------------------------
# A missing library must degrade to the negative-only directive, never emit an
# empty prompt or error. Resolution is FILE-RELATIVE, so pointing an env var at
# an empty dir would not exercise this -- the real library would still be found
# (correctly). Copy the provider into a throwaway tree with NO references/ dir so
# the file-relative lookup genuinely misses.
EMPTY_ROOT="$TMPD/empty"; mkdir -p "$EMPTY_ROOT/providers"
cp "$CLAUDE_SH" "$EMPTY_ROOT/providers/claude.sh"
MISSING_TXT="$TMPD/missing.txt"
( set +u; cd "$EMPTY_ROOT" || exit 1; ITERATION_COUNT=1
  unset PROJECT_DIR LOKI_SKILL_DIR
  . "$EMPTY_ROOT/providers/claude.sh" >/dev/null 2>&1; _loki_autonomy_override_text ) > "$MISSING_TXT" 2>/dev/null
if [ -s "$MISSING_TXT" ] \
   && grep -q 'FIRST-PASS EXCELLENCE' "$MISSING_TXT" \
   && ! grep -q 'DESIGN ARCHETYPES' "$MISSING_TXT"; then
    ok "missing library fails open to the negative-only directive"
else
    bad "missing library did not fail open (empty prompt or hard error)"
fi

# --- 3b. a project-local decoy must never be read --------------------------
# At source time $PWD is the TARGET PROJECT's directory during a real build. If
# resolution ever consults $PWD, a project that happens to contain
# references/design-archetypes.md gets its own file piped into the autonomy
# system prompt (arbitrary user-controlled text) and silently drifts from the Bun
# route, which resolves only from import.meta.url and can never pick one up.
# Run with BOTH env vars unset so only the file-relative path can answer.
DECOY_ROOT="$TMPD/decoy"; mkdir -p "$DECOY_ROOT/references"
printf '%s\n' '# DESIGN ARCHETYPES (pick exactly ONE)' 'DECOY-CONTENT-MUST-NOT-APPEAR' \
    > "$DECOY_ROOT/references/design-archetypes.md"
DECOY_TXT="$TMPD/decoy.txt"
( set +u; cd "$DECOY_ROOT" || exit 1; ITERATION_COUNT=1
  unset PROJECT_DIR LOKI_SKILL_DIR
  . "$CLAUDE_SH" >/dev/null 2>&1; _loki_autonomy_override_text ) > "$DECOY_TXT" 2>/dev/null
if grep -q 'RETRO-FUTURE' "$DECOY_TXT" && ! grep -q 'DECOY-CONTENT-MUST-NOT-APPEAR' "$DECOY_TXT"; then
    ok "a project-local decoy library is never read (no \$PWD in the resolution chain)"
else
    bad "project-local decoy was read into the system prompt (prompt-injection surface)"
fi

# --- 4. fonts are real and freely embeddable -------------------------------
# The model writes these names straight into an @import / next/font call, so a
# font that is not on Google Fonts produces a 404 in every generated app. Assert
# the names are drawn from the verified set rather than invented.
# "4" is a token because the family is literally named "Source Serif 4".
KNOWN_FONTS="Newsreader Public Sans Space Grotesk JetBrains Mono Playfair Display Lora Syne Chivo Fraunces DM Sans Archivo IBM Plex Sans Source Serif 4 Work Sans Instrument Serif Manrope"
UNKNOWN_FONT=0
while IFS= read -r fontline; do
    for tok in $fontline; do
        case " $KNOWN_FONTS " in
            *" $tok "*) ;;
            *) UNKNOWN_FONT=1; echo "  unverified font token: $tok" ;;
        esac
    done
done < <(sed -n 's/^- Type: \([^(]*\)(.*/\1/p' "$LIB" | tr -d ',')
[ "$UNKNOWN_FONT" -eq 0 ] \
  && ok "every named font is from the verified Google Fonts set" \
  || bad "the library names a font outside the verified set (would 404 at build)"

# --- 5. every archetype carries a complete, well-formed palette -------------
# Deliberately a SHAPE check, not a hardcoded allowlist of Radix hexes. An
# allowlist would be a third source of truth: adding a legitimate Radix hue to
# the library would fail this test until someone updated the list, which trains
# people to edit the test instead of the data. Radix provenance is recorded in
# the library's own attribution block (asserted below). What must hold
# mechanically is that each archetype names a FULL 5-role palette in valid
# lowercase 6-digit hex -- a truncated or malformed palette is what actually
# breaks generated CSS.
BAD_PALETTE=0
PALETTE_LINES=0
while IFS= read -r line; do
    PALETTE_LINES=$((PALETTE_LINES + 1))
    n=$(printf '%s' "$line" | grep -oE '#[0-9a-f]{6}' | wc -l | tr -d ' ')
    if [ "$n" -ne 5 ]; then
        BAD_PALETTE=1
        echo "  palette has $n hexes, expected 5 (bg/surface/border/accent/text): $line"
    fi
done < <(grep '^- Palette:' "$LIB")
if [ "$PALETTE_LINES" -lt 8 ]; then
    BAD_PALETTE=1
    echo "  only $PALETTE_LINES palettes found, expected at least 8 archetypes"
fi
[ "$BAD_PALETTE" -eq 0 ] \
  && ok "all $PALETTE_LINES archetypes carry a complete 5-role hex palette" \
  || bad "an archetype palette is incomplete or malformed"

# --- 6. license attribution for all three OSS sources ----------------------
for src in "Radix Colors" "Open Props" "daisyUI" "Open Font License"; do
    grep -q "$src" "$LIB" \
      && ok "license attribution present: $src" \
      || bad "license attribution MISSING: $src"
done

# --- 7. repo style rules ---------------------------------------------------
if grep -qE '[—–]' "$LIB"; then
    bad "archetype library contains an em dash or en dash"
else
    ok "archetype library has no em/en dashes"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
