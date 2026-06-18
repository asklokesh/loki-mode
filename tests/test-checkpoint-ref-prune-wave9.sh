#!/usr/bin/env bash
# Test: WAVE9 fixes in autonomy/run.sh
#
# 1. checkpoint leak (MED): when create_checkpoint prunes old checkpoint
#    DIRECTORIES (retention: keep last 50), it must ALSO delete the
#    corresponding refs/loki/cp/<id> git refs. Before the fix the dirs were
#    rm -rf'd but the refs (and their anchored stash commits) leaked forever.
#
# 2. provider-F2 (MED): the dead invoke_with_timeout() helper and its
#    PROVIDER_SPAWN_TIMEOUT / PROVIDER_SPAWN_RETRIES vars were removed. This
#    test asserts they are gone (no live definition / no consumers).
#
# autonomy/run.sh uses `set -uo pipefail` (NOT set -e); this test uses
# `set -uo pipefail` too and tolerates non-zero from probes explicitly.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

fail=0

#==============================================================================
# Part 1: provider-F2 -- dead invoke_with_timeout removed
#==============================================================================
echo "=== Part 1: provider-F2 dead-code removal ==="

# The function definition must be gone. Only an explanatory comment may mention
# the name, so we look specifically for a function-definition line.
if grep -Eq '^[[:space:]]*invoke_with_timeout[[:space:]]*\(\)' "$RUN_SH"; then
    echo "FAIL: invoke_with_timeout() function definition still present"
    fail=1
else
    echo "PASS: invoke_with_timeout() function definition removed"
fi

# The two driver vars must be gone entirely (definition AND any consumer).
if grep -q "PROVIDER_SPAWN_TIMEOUT\|PROVIDER_SPAWN_RETRIES" "$RUN_SH"; then
    echo "FAIL: PROVIDER_SPAWN_TIMEOUT / PROVIDER_SPAWN_RETRIES still referenced"
    grep -n "PROVIDER_SPAWN_TIMEOUT\|PROVIDER_SPAWN_RETRIES" "$RUN_SH"
    fail=1
else
    echo "PASS: PROVIDER_SPAWN_TIMEOUT / PROVIDER_SPAWN_RETRIES removed"
fi

#==============================================================================
# Part 2: checkpoint leak -- prune deletes refs/loki/cp/<id>
#==============================================================================
echo ""
echo "=== Part 2: checkpoint ref pruning ==="

# Confirm the fix is wired into the prune loop in source: the update-ref -d must
# appear inside create_checkpoint's retention block (before the rm -rf).
if grep -q 'git update-ref -d "refs/loki/cp/${old_cp}"' "$RUN_SH"; then
    echo "PASS: prune loop deletes refs/loki/cp/<id> in source"
else
    echo "FAIL: prune loop does not delete refs/loki/cp/<id>"
    fail=1
fi

# Functional reproduction of the exact prune snippet against a REAL git repo.
# We create >50 checkpoint dirs + anchored refs, run the prune logic, and assert
# the pruned ids' refs are gone while the kept ids' refs remain.
if command -v git >/dev/null 2>&1; then
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-cp-ref.XXXXXX")"
    cleanup() { rm -rf "$WORK"; }
    trap cleanup EXIT

    (
        cd "$WORK" || exit 1
        git init -q
        git config user.email "t@t.t"
        git config user.name "t"
        echo seed > seed.txt
        git add seed.txt
        git commit -qm seed

        checkpoint_dir=".loki/state/checkpoints"
        mkdir -p "$checkpoint_dir"

        # Create 55 checkpoints: dir + an anchored stash-create ref each. Epoch
        # suffix is monotonically increasing so sort -k3 -n yields create order.
        total=55
        i=0
        while [ "$i" -lt "$total" ]; do
            epoch=$((1000 + i))
            id="cp-${i}-${epoch}"
            mkdir -p "$checkpoint_dir/$id"
            printf '{}\n' > "$checkpoint_dir/$id/metadata.json"
            # Make a real dangling commit and anchor it under refs/loki/cp/<id>,
            # exactly like create_checkpoint does via `git stash create`.
            echo "change-$i" > work.txt
            git add work.txt
            snap_sha="$(git stash create "cp $id" 2>/dev/null || echo "")"
            git checkout -q -- work.txt 2>/dev/null || rm -f work.txt
            if [ -n "$snap_sha" ]; then
                git update-ref "refs/loki/cp/${id}" "$snap_sha"
            fi
            i=$((i + 1))
        done

        refs_before="$(git for-each-ref --format='%(refname)' 'refs/loki/cp/*' | wc -l | tr -d ' ')"
        echo "refs before prune: $refs_before (expect 55)"

        # --- exact prune snippet copied from create_checkpoint (WAVE9) ---
        cp_count=$(find "$checkpoint_dir" -maxdepth 1 -type d -name "cp-*" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$cp_count" -gt 50 ]; then
            to_remove=$((cp_count - 50))
            find "$checkpoint_dir" -maxdepth 1 -type d -name "cp-*" 2>/dev/null \
                | while read -r p; do basename "$p"; done | sort -t'-' -k3 -n \
                | head -n "$to_remove" | while read -r old_cp; do
                git update-ref -d "refs/loki/cp/${old_cp}" 2>/dev/null || true
                old_cp="${checkpoint_dir}/${old_cp}"
                rm -rf "$old_cp" 2>/dev/null || true
            done
        fi

        refs_after="$(git for-each-ref --format='%(refname)' 'refs/loki/cp/*' | wc -l | tr -d ' ')"
        echo "refs after prune : $refs_after (expect 50)"

        # The 5 oldest ids (cp-0..cp-4) were pruned: their refs must be gone.
        pf=0
        for pruned in 0 1 2 3 4; do
            id="cp-${pruned}-$((1000 + pruned))"
            if git show-ref --verify --quiet "refs/loki/cp/${id}"; then
                echo "FAIL: pruned ref refs/loki/cp/${id} still exists (LEAK)"
                pf=1
            fi
        done
        # A kept id (the newest, cp-54) must still have its ref.
        keep_id="cp-54-$((1000 + 54))"
        if ! git show-ref --verify --quiet "refs/loki/cp/${keep_id}"; then
            echo "FAIL: kept ref refs/loki/cp/${keep_id} was wrongly deleted"
            pf=1
        fi

        if [ "$refs_after" = "50" ] && [ "$pf" -eq 0 ]; then
            echo "PASS: prune deleted exactly the pruned refs, kept the rest"
            exit 0
        fi
        exit 1
    )
    if [ $? -ne 0 ]; then
        fail=1
    fi
else
    echo "SKIP: git not available for functional ref-prune reproduction"
fi

echo ""
if [ "$fail" -ne 0 ]; then
    echo "RESULT: FAIL"
    exit 1
fi
echo "RESULT: ALL CHECKS PASSED"
