#!/usr/bin/env bash
# v7.8.1 regression test: staleness-aware generated-PRD reuse.
# The codebase signature + decision logic decides reuse|update|generate on a
# no-PRD run so the generated PRD is reused when the codebase is unchanged and
# only updated (not regenerated) when it changed.
set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/autonomy/run.sh"

# --- static wiring -----------------------------------------------------------
grep -q 'compute_codebase_signature()' "$SRC" \
  && ok "run.sh defines compute_codebase_signature" || bad "no compute_codebase_signature"
grep -q 'decide_generated_prd_action()' "$SRC" \
  && ok "run.sh defines decide_generated_prd_action" || bad "no decide_generated_prd_action"
grep -q 'persist_prd_signature_if_present "\$exit_code"' "$SRC" \
  && ok "run.sh CALLS persist_prd_signature_if_present post-iteration" || bad "persist not called"
grep -q 'GENERATED_PRD_UPDATE_MODE' "$SRC" \
  && ok "run.sh has the incremental update_instruction" || bad "no update_instruction"
grep -q 'three passes' "$SRC" \
  && ok "run.sh has the improved 3-pass analysis instruction" || bad "analysis instruction not improved"
grep -q 'regen-prd' "$REPO_ROOT/autonomy/loki" \
  && grep -q 'export LOKI_PRD_REGEN=1' "$REPO_ROOT/autonomy/loki" \
  && ok "loki --regen-prd exports LOKI_PRD_REGEN=1" || bad "--regen-prd not wired"
grep -q -- '--fresh-prd' "$REPO_ROOT/autonomy/loki" \
  && ok "loki --fresh-prd alias is wired" || bad "--fresh-prd not wired"
# reuse disclosure must name the date and the --fresh-prd lever (honest behavior)
grep -q 'Reusing the PRD last generated or updated on' "$SRC" \
  && grep -q 'pass --fresh-prd to regenerate' "$SRC" \
  && ok "reuse disclosure names the generated date and --fresh-prd" || bad "reuse disclosure incomplete"
grep -q 'hand-edited PRD as-is' "$SRC" \
  && ok "user_owned disclosure present (hand-edited PRD used as-is)" || bad "no user_owned disclosure"
grep -q 'user_owned' "$SRC" \
  && ok "run.sh has the user_owned (hand-edit) decision branch" || bad "no user_owned branch"

bash -n "$SRC" && ok "autonomy/run.sh passes bash -n" || bad "run.sh syntax error"
bash -n "$REPO_ROOT/autonomy/loki" && ok "autonomy/loki passes bash -n" || bad "loki syntax error"

# --- functional: load the helpers and exercise them --------------------------
eval "$(awk '/^_loki_hash_stdin\(\)/,/^}/' "$SRC")"
eval "$(awk '/^_loki_prd_file_hash\(\)/,/^}/' "$SRC")"
eval "$(awk '/^compute_codebase_signature\(\)/,/^}/' "$SRC")"
eval "$(awk '/^decide_generated_prd_action\(\)/,/^}/' "$SRC")"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/loki-prdreuse-XXXXXX")
( cd "$WORK" && git init -q && git config user.email t@t && git config user.name t \
  && echo "print(1)" > app.py && git add app.py && git commit -qm init ) 2>/dev/null
mkdir -p "$WORK/.loki/state"

SIG1=$(compute_codebase_signature "$WORK")
SIG2=$(compute_codebase_signature "$WORK")
[ -n "$SIG1" ] && [ "$SIG1" = "$SIG2" ] && ok "signature is deterministic" || bad "signature not stable ($SIG1 vs $SIG2)"

# .loki churn must NOT change the signature
mkdir -p "$WORK/.loki/logs"; echo noise > "$WORK/.loki/logs/x.log"; echo s > "$WORK/.loki/state/y.json"
SIG_AFTER_CHURN=$(compute_codebase_signature "$WORK")
[ "$SIG1" = "$SIG_AFTER_CHURN" ] && ok "signature ignores .loki churn" || bad "signature changed on .loki churn"

# a real edit (uncommitted) must change the signature
echo "y=2" >> "$WORK/app.py"
SIG_EDIT=$(compute_codebase_signature "$WORK")
[ "$SIG1" != "$SIG_EDIT" ] && ok "signature detects an uncommitted edit" || bad "signature missed an edit"
( cd "$WORK" && git checkout -q app.py ) 2>/dev/null

# an untracked NEW file must change the signature (no false reuse)
echo "new" > "$WORK/newfile.py"
SIG_UNTRACKED=$(compute_codebase_signature "$WORK")
[ "$SIG1" != "$SIG_UNTRACKED" ] && ok "signature detects an untracked new file" || bad "signature missed an untracked file"
rm -f "$WORK/newfile.py"

# decision: no generated PRD -> generate
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "generate" ] \
  && ok "decision: no generated PRD -> generate" || bad "decision: expected generate (first run)"

# generated PRD, no signature -> update
echo "# prd" > "$WORK/.loki/generated-prd.md"
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "update" ] \
  && ok "decision: PRD present but no signature -> update" || bad "decision: expected update (no provenance)"

# matching signature -> reuse
CUR=$(compute_codebase_signature "$WORK")
printf '{"signature":"%s"}\n' "$CUR" > "$WORK/.loki/state/prd-signature.json"
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "reuse" ] \
  && ok "decision: signature matches -> reuse" || bad "decision: expected reuse (unchanged)"

# codebase changed -> update
echo "z=3" >> "$WORK/app.py"
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "update" ] \
  && ok "decision: codebase changed -> update" || bad "decision: expected update (changed)"
( cd "$WORK" && git checkout -q app.py ) 2>/dev/null

# force regen
[ "$(TARGET_DIR="$WORK" LOKI_PRD_REGEN=1 decide_generated_prd_action)" = "generate" ] \
  && ok "decision: LOKI_PRD_REGEN=1 -> generate (force)" || bad "decision: expected generate (forced)"

# back-to-back with no change -> still reuse (no perpetual update)
printf '{"signature":"%s"}\n' "$(compute_codebase_signature "$WORK")" > "$WORK/.loki/state/prd-signature.json"
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "reuse" ] \
  && ok "decision: back-to-back unchanged -> reuse (no perpetual update)" || bad "decision: perpetual update detected"

# --- hand-edit detection (req 4): recorded prd_sha matches -> reuse, differs -> user_owned
CUR2=$(compute_codebase_signature "$WORK")
PRDSHA=$(TARGET_DIR="$WORK" _loki_prd_file_hash "$WORK")
printf '{"signature":"%s","prd_sha":"%s"}\n' "$CUR2" "$PRDSHA" > "$WORK/.loki/state/prd-signature.json"
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "reuse" ] \
  && ok "decision: matching prd_sha + sig -> reuse (Loki-owned, unchanged)" || bad "decision: expected reuse with prd_sha"
# user hand-edits the generated PRD -> file hash drifts from recorded prd_sha
echo "## hand-added by the user" >> "$WORK/.loki/generated-prd.md"
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "user_owned" ] \
  && ok "decision: hand-edited generated PRD -> user_owned (use as-is)" || bad "decision: hand-edit not detected"
# force-regen still wins over a hand-edit (precedence)
[ "$(TARGET_DIR="$WORK" LOKI_PRD_REGEN=1 decide_generated_prd_action)" = "generate" ] \
  && ok "decision: --fresh-prd overrides a hand-edited PRD (force precedence)" || bad "decision: force did not override user_owned"
# restore the Loki-written content so later cases are unaffected
printf '# prd\n' > "$WORK/.loki/generated-prd.md"

# --- date preservation: persist keeps generated_at stable across unchanged reuse
# Extract get_version (with a fallback) and persist into THIS shell, then call
# it inside a cd-subshell (functions are inherited by subshells, so no fragile
# re-serialization of the function body, which embeds python and quotes).
get_version() { echo test; }
eval "$(awk '/^persist_prd_signature_if_present\(\)/,/^}/' "$SRC")"
DATE_GET='import json,os;print(json.load(open(os.environ["F"])).get(os.environ["K"],""))'
( cd "$WORK" && TARGET_DIR="." prd_path=".loki/generated-prd.md" persist_prd_signature_if_present 0 ) 2>/dev/null
DATE1=$(F="$WORK/.loki/state/prd-signature.json" K=generated_at python3 -c "$DATE_GET" 2>/dev/null)
SHA1=$(F="$WORK/.loki/state/prd-signature.json" K=prd_sha python3 -c "$DATE_GET" 2>/dev/null)
[ -n "$DATE1" ] && [ -n "$SHA1" ] && ok "persist writes generated_at and prd_sha" || bad "persist missing generated_at/prd_sha"
( cd "$WORK" && TARGET_DIR="." prd_path=".loki/generated-prd.md" persist_prd_signature_if_present 0 ) 2>/dev/null
DATE2=$(F="$WORK/.loki/state/prd-signature.json" K=generated_at python3 -c "$DATE_GET" 2>/dev/null)
[ "$DATE1" = "$DATE2" ] && ok "persist preserves generated_at across unchanged reuse (honest date)" || bad "generated_at drifted on reuse ($DATE1 vs $DATE2)"

# --- user_owned does NOT re-baseline: after a hand-edit + persist, a second
# decide must still return user_owned (req 4: persists until --fresh-prd).
CUR3=$(compute_codebase_signature "$WORK")
PRDSHA3=$(TARGET_DIR="$WORK" _loki_prd_file_hash "$WORK")
printf '{"signature":"%s","prd_sha":"%s"}\n' "$CUR3" "$PRDSHA3" > "$WORK/.loki/state/prd-signature.json"
echo "## user hand-edit" >> "$WORK/.loki/generated-prd.md"
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "user_owned" ] \
  && ok "decision: hand-edit detected before persist (user_owned)" || bad "decision: hand-edit not detected (pre-persist)"
# a persist while user_owned must NOT rewrite the signature file (no re-baseline)
( cd "$WORK" && TARGET_DIR="." prd_path=".loki/generated-prd.md" GENERATED_PRD_ACTION=user_owned persist_prd_signature_if_present 0 ) 2>/dev/null
[ "$(TARGET_DIR="$WORK" decide_generated_prd_action)" = "user_owned" ] \
  && ok "decision: still user_owned after a persist (no silent re-baseline)" || bad "decision: re-baselined to reuse after persist"
printf '# prd\n' > "$WORK/.loki/generated-prd.md"

# --- non-git fallback: prunes .loki, deterministic ---------------------------
NG=$(mktemp -d "${TMPDIR:-/tmp}/loki-prdreuse-ng-XXXXXX")
echo "a" > "$NG/a.py"; mkdir -p "$NG/.loki/state"
NG1=$(compute_codebase_signature "$NG")
echo "noise" > "$NG/.loki/state/churn.json"
NG2=$(compute_codebase_signature "$NG")
case "$NG1" in files:*) ok "non-git fallback uses files: mode" ;; *) bad "non-git mode wrong: $NG1" ;; esac
[ "$NG1" = "$NG2" ] && ok "non-git fallback prunes .loki (stable)" || bad "non-git .loki not pruned"
echo "b" > "$NG/b.py"
NG3=$(compute_codebase_signature "$NG")
[ "$NG1" != "$NG3" ] && ok "non-git fallback detects a new file" || bad "non-git missed a new file"
rm -rf "$NG"

rm -rf "$WORK"

# --- no em dashes ------------------------------------------------------------
if grep -lP '\xe2\x80\x94' "$SRC" "$REPO_ROOT/autonomy/loki" "$SCRIPT_DIR/test-prd-reuse.sh" >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
