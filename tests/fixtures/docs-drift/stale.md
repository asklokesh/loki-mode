**Version:** v1.0.0

Positive control for tests/test-docs-cli-drift.sh. Each line below the rule
must be reported, except the last two, which name a real surface.

```bash
loki doc02-bogus-cmd
loki start --doc02-not-a-real-flag ./prd.md
```

The current version is v2.3.4.

`loki start --help` and `loki owner/repo#123` are fine.
