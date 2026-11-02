# Known issues

Issues in the current release that are known and not yet fixed. Report new ones with `loki crash` or at https://github.com/asklokesh/loki-mode/issues.

## Which engine runs

From 11.4.0, `loki start`, `loki "<task>"`, `loki owner/repo#N` and `loki quick` run the Loki 10 engine whatever the flag order or input form. The previous loop runs only on `--engine legacy`, `LOKI_ENGINE=legacy`, for a provider with no Loki 10 invoker, for a PRD over 100000 bytes, or never because of a flag: a flag Loki 10 cannot honor (`--simple`, `--sandbox`, `--ship`, `--worktree`, `--detach`, `--parallel`, ...) is refused with exit 2 and names its replacement, and `--engine legacy` keeps it. `--pr` is accepted (Loki 10 opens the PR by default), `--quiet` and `--resume` are honored, and `--dry-run` prints the route, max-cost and run cap without starting. Check with `loki route start <args> --json`: it reports `engine`, `adapter`, `reason` and `capability_differences`. The full table is in the Routing contract section of `docs/exit-codes.md`.

## Exit codes

The exit code of every command is listed in `docs/exit-codes.md`. Two things are kept as they are for compatibility:

- `loki run` (deprecated alias of `loki start <issue-ref>`) exits 1 on an unknown option, not 64.
- `loki start` without `LOKI_DURABLE_STATE=1` has no finer run-outcome signal than 0 versus nonzero.

An empty diff has a distinct exit code only for `loki verify` (3). `loki quick`, `loki start` and `loki run` do not define one.
