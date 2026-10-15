# Known issues

Issues in the current release that are known and not yet fixed. Report new ones with `loki crash` or at https://github.com/asklokesh/loki-mode/issues.

## Which engine runs

From 11.4.0, `loki start`, `loki "<task>"`, `loki owner/repo#N` and `loki quick` run the Loki 10 engine whatever the flag order or input form. The previous loop runs only on `--engine legacy`, `LOKI_ENGINE=legacy`, or for one call when a flag Loki 10 cannot honor is present (`--simple`, `--parallel`, `--sandbox`, ...). Check with `loki route start <args>`.
