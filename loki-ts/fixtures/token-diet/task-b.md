# Boolean options reject "on"/"off" and any capitalized spelling

`parseArgs(["--verbose=on"], opts)` throws `SpecError: --verbose expects a boolean, got on`, and `fromEnv` fails the same way for `ARGKIT_VERBOSE=ON` or `ARGKIT_DRY_RUN=True`. Shell users and `.env` files write these spellings all the time.

## Expected
Everywhere a boolean value is read (the `--flag=value` form and environment variables), accept `on`/`off` as well as the existing `true`/`false`, `1`/`0`, `yes`/`no`, case-insensitively and ignoring surrounding whitespace. Anything else still throws the same `SpecError`.

Add regression tests next to the existing parser and env tests.
