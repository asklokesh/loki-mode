# Known issues

Issues in the current release that are known and not yet fixed. Report new ones with `loki crash` or at https://github.com/asklokesh/loki-mode/issues.

## `loki verify` exit codes differ from the target table in three cases

| Input | Command | Exit today | Target |
|---|---|---|---|
| Empty diff (a git repo with no changes vs base) | `loki verify` | 1 (CONCERNS) | 3 |
| Not a git directory | `loki verify` | 1 (CONCERNS) | 2 |
| Unknown flag | `loki verify` with a flag it does not know | 3 | 64 |

Changing these is a breaking change for CI gates, so it waits for a planned release. Details: [exit-codes.md](exit-codes.md#known-gaps).

## `loki start` uses the older engine

`loki "<task>"`, `loki owner/repo#N` and `loki quick` run the Loki 10 engine. `loki start ./prd.md` still routes to the older engine, which is being removed. Prefer `loki owner/repo#N` or `loki "<task>"`.
