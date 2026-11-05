# A bare "-" argument silently discards every argument after it in parseArgs

`parseArgs` (src/parse.js) handles a lone `-` by pushing it to `positionals` and then executing `break`, which leaves the whole loop. Every argument after the `-` is dropped without an error: `tool - foo bar` yields `positionals == ["-"]`.

Every sibling branch in the same loop preserves the remainder (`--` and numeric tokens push `rest.slice(1)` / `rest` and return; a plain positional pushes and `continue`s). The lone `-` is the only branch that loses data.

## Expected
A lone `-` is an ordinary operand (the stdin placeholder), exactly like Node's `util.parseArgs` and POSIX getopt treat it: it is kept as a positional and option parsing continues after it.

- `parseArgs(["-", "foo", "bar"])` returns positionals `["-", "foo", "bar"]`
- `parseArgs(["-", "--verbose"], opts)` sets `verbose` and returns positionals `["-"]`
- With `stopAtPositional: 1`, the `-` counts as that first positional.

Add a regression test next to the existing parser tests.
