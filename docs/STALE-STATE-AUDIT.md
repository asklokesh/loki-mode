# Stale-State Audit

Audit for siblings of the `loki.pgid` session-killer (fixed in 4792b521).

**The shape being hunted:** a file recording a PID, PGID, port, lock, or session
id, written by one run, NOT removed on abnormal exit, later TRUSTED by another
run after the OS recycled the identifier.

**Method:** grep for the write, find its `rm -f`, check whether a trap covers
INT/TERM/crash, then check whether the reader proves the record is still
current. Every candidate was measured on this host rather than judged by
reading, because the pgid finding was credible on evidence (155h/202h orphans),
not on the code looking wrong.

Scope: read-only across the repo; fix applied to one file (`autonomy/run.sh`).

---

## Measured state of this host

Run from the repo root on 2026-08-08:

| File | Contents | Live? | Age |
|---|---|---|---|
| `~/.loki/dashboard/dashboard.pid` | absent | n/a | n/a |
| `.loki/dashboard/dashboard.pid` | `87992` | **DEAD** | **mtime Jul 31 (8 days)** |
| `$TMPDIR/loki-local-ci.lock` | `61876` | LIVE (real local-ci) | current |
| `.loki/app-runner/app.pid` | absent | n/a | n/a |

The dashboard pid file is the same measured shape as the pgid orphans: a dead
identifier, days old, still on disk, still trusted by a code path that kills.

---

## Findings, ranked by blast radius

### FINDING 1 (HIGH -- fixed here): shared dashboard pid is killed unverified

**Evidence.** `autonomy/run.sh:1597-1600` reads a pid from
`~/.loki/dashboard/dashboard.pid` and sends it `kill` then `kill -9` with no
liveness and no identity check.

Removal of that file happens ONLY on explicit stop paths -- `run.sh:16608`,
`:16658`, `:17399`, and `autonomy/loki:7078-7079`. **No trap covers a crash or
Ctrl+C.** That is precisely why the measured copy in this checkout is 8 days
stale with a dead pid.

**Reachable:** yes. Called from `cleanup` on both stop paths (`run.sh:25311`,
`:25384`).

**Blast radius: the worst class.** The file lives under `~/.loki`, so it is
machine-global -- the victim need not belong to this project. A recycled pid
names an unrelated live process and receives `kill -9`.

**Why `kill -0` would not have fixed it:** a recycled pid IS alive, so a
liveness check passes. This is the identical insufficiency the `loki.pgid`
self-check had. The guard has to check IDENTITY.

**Fix applied.** `_loki_pid_looks_like_dashboard()` at `autonomy/run.sh:1526`,
gating the kill at `:1597`. It mirrors `_app_runner_pid_is_ours`
(`app-runner.sh:242`) and **fails OPEN**: when `ps` reports nothing we signal
exactly as before, so a legitimate dashboard is never left running by this
check. The only behavior change is refusing to kill a process positively
identified as not a dashboard.

Deliberately NOT done: adding a trap to remove the pid file on crash. That is a
larger change across the dashboard lifecycle, and the identity guard already
makes a stale file harmless at the point where it does damage. The stale file
still being present is untidy, not dangerous, once the killer verifies.

**Test:** `tests/test-stale-dashboard-pid.sh`, 6/6, mutation-verified below.

### FINDING 2 (MEDIUM -- reported, not fixed): `app_runner_stop` group-kills unverified

**Evidence.** `app-runner.sh:1407` falls back to reading `app.pid` from disk,
then `:1456` sends `kill -TERM "-$_APP_RUNNER_PID"` -- a **process-group**
signal -- without an identity check.

The repo already has the right guard: `_app_runner_pid_is_ours`
(`app-runner.sh:242`). It is called at `:1657` and `:1829` but **not** on the
stop path. `app-runner.sh` has **no trap at all** (`grep -n "trap " ` returns
nothing), so `app.pid` survives a crash exactly like the pgid file did.

**Blast radius:** higher per-hit than Finding 1 (a group signal reaches a whole
tree) but narrower reach: the file is project-local (`.loki/app-runner/`), not
machine-global, and was absent on this host. Not fixed because it is a third
file and the lead scoped this task to one; it needs its own change adding
`_app_runner_pid_is_ours` to the stop path.

### FINDING 3 (LOW -- reported, not fixed): local-ci lock guard is a no-op under `/bin/bash`

**Evidence.** `scripts/local-ci.sh:104`:

```
trap '[ "$$" = "$_lci_owner" ] && rm -f "$_lci_lock" 2>/dev/null || true' EXIT
```

The scar comment above it (`:99-103`) correctly diagnoses that a bare EXIT trap
fires in every subshell and that a finishing child deleted the parent's lock.
**But `$$` does not change in a bash subshell, so this guard does not
discriminate.** Verified:

```
$ bash -c 'p=$$; ( [ "$$" = "$p" ] && echo same )'
same
```

The correct discriminators are `BASHPID` (bash 4+) or `BASH_SUBSHELL` (works in
3.2). Measured on this host: the script is `#!/usr/bin/env bash` which resolves
to **bash 5.3**, where `BASHPID` is available. But `/bin/bash` here is **3.2**,
where `BASHPID` is unset and `BASH_SUBSHELL` is the version-safe choice.

**Blast radius: benign** by the lead's own criterion. Worst case is two
concurrent local-ci runs starving each other into phantom failures -- costly in
time and trust, but it kills nothing. Left unfixed as out of scope; the one-line
change is `[ "${BASH_SUBSHELL:-0}" = 0 ]`.

Note on the sibling fix already shipped: `_loki_remove_pgid_file`
(`run.sh:25189`) uses `${BASHPID:-$$}`. Under bash 3.2 that collapses to `$$`
and the guard degrades to the no-op. **The degradation direction is safe** -- a
subshell deletes the pgid file early, the reap then finds no file and skips, so
an orphan survives and nobody gets killed. `run.sh` is also `#!/usr/bin/env
bash` (5.3 here), so this is a portability note, not a live defect. Worth
knowing: the mutation test for that guard asserts *source text* contains
`BASHPID`, so it proves the code is present, not that it behaves correctly on a
3.2 host.

---

## Already guarded -- do not re-audit

Checked and found correct. Listed explicitly so this ground is not covered
twice.

- **`autonomy/lib/lock.sh:56-67`** -- `_loki_lock_is_stale` requires the
  sentinel PID to be dead **AND** mtime > 30s. Both conditions, not either.
  Correct.
- **`cleanup_orphan_pids` (`run.sh:2300+`)** -- reaps only on liveness AND
  parent death AND (for wrappers) idle-past-budget AND no live engine child.
  Also self-skips `$$`. Correct, and notably stricter than the pgid reap was.
- **`_app_runner_pid_is_ours` (`app-runner.sh:242`)** -- a real identity token
  captured post-exec, failing open on a missing token so a live app is never
  falsely killed. Correct where it is called; see Finding 2 for where it is not.
- **`_app_runner_collect_descendants` (`app-runner.sh:289`)** -- refuses pid
  0/1 and walks parent-child links from our own pid only, so it structurally
  cannot signal outside our subtree. Correct.
- **`status.ts:266-270` and the bash status reader (`loki:5092`)** -- both do
  `os.kill(pid, 0)` before reporting. A wrong answer only mislabels a URL in
  status output. Benign even when stale.
- **The `CLEAR`/`KEEP` registry check (`run.sh:1545-1560`)** -- correctly
  refuses to tear the shared dashboard down while any other project holds a
  live pid. This gates Finding 1's call site; the defect was the missing check
  on the pid itself, not this decision.

---

## Mutation verification (Finding 1's fix)

Each guard was reverted individually; the test must go red, and only on its own
assertion.

| Mutation | Before | After | Assertion killed |
|---|---|---|---|
| Identity check downgraded to bare `kill -0` | 6 pass / 0 fail | 5 / 1 | "a live non-dashboard process is refused" |
| Call site ungated (guard present but unused) | 6 / 0 | 5 / 1 | "the kill is gated on the identity guard" |
| `pid > 1` check removed | 6 / 0 | 5 / 1 | "pid 0/1, empty and malformed inputs refused" |

Restored after each. Final: `bash -n autonomy/run.sh` clean,
`tests/test-stale-dashboard-pid.sh` 6/6, `tests/test-pgid-stale-reap.sh` 8/8
(unaffected).

The first mutation is the important one: it replaces the identity check with
exactly the insufficient guard (`kill -0`) that a reviewer would most likely
propose, and the test catches it.
