# Known issues

Issues in the current release that are known and not yet fixed. Report new ones with `loki crash` or at https://github.com/asklokesh/loki-mode/issues.

## `loki start` uses the older engine

`loki "<task>"`, `loki owner/repo#N` and `loki quick` run the Loki 10 engine. `loki start ./prd.md` still routes to the older engine, which is being removed. Prefer `loki owner/repo#N` or `loki "<task>"`.
