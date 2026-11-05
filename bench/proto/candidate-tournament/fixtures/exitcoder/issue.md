exitCodeFor ignores an ExitError or MultiError wrapped with `cause`

Callers commonly wrap errors: `new Error("deploy failed", { cause: new ExitError("bad", 4) })`.
exitCodeFor looks for an ExitError (and for a MultiError) with a bare instanceof check, so a wrapped one maps to 1.
The same bare check is used for the members of a MultiError. Every place that looks for an ExitError or MultiError
should look through the `cause` chain.

    exitCodeFor(new Error("deploy failed", { cause: new ExitError("bad", 4) }))  // actual 1, expected 4
