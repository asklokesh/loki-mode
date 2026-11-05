parseArgs drops every argument after a lone "-"

A lone `-` (conventionally "read from stdin") is accepted as a positional argument, but parsing stops there:
everything after it is silently dropped, including flags.

    parseArgs(["-", "--verbose", "file.txt"])
    // actual:   { flags: {}, positional: ["-"] }
    // expected: { flags: { verbose: true }, positional: ["-", "file.txt"] }

A lone `-` should be a positional argument like any other, and parsing should continue after it.
