Report does not see a StatusCoder or GroupError wrapped with %w

`Report` looks for a `StatusCoder` (and for a `GroupError`) with a bare type assertion, so an error wrapped with
`fmt.Errorf("...: %w", err)` is ignored and the process does not exit with the status.

```go
Report(fmt.Errorf("loading config: %w", NewCode("boom", 3))) // should print "boom" and exit 3; does nothing
```

Expected: use `errors.As` so wrapped errors are found, for example:

```go
var sc StatusCoder
if errors.As(err, &sc) {
```

The same bare assertion is used for the errors inside a group in `reportGroup`.
