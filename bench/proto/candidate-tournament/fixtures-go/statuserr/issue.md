# Report does not see a StatusCoder wrapped with %w

### What happened

`Report` looks for a `StatusCoder` (and for a `Batch`) with a **bare type assertion**, so a status error that has been wrapped with `fmt.Errorf("%w")` is not recognised. Nothing calls `Exiter` and nothing is written to `ErrWriter`.

```go
err := fmt.Errorf("sync failed: %w", statuserr.Status("disk quota exceeded", 9))
statuserr.Report(err)
```

Running that prints nothing, and `Exiter` is never called instead of being called with `9`.

### Why it matters

`Status` documents that the underlying error stays reachable through the standard wrapping helpers. Adding context with `%w` is the ordinary way to do it, and the only consumer of that promise, `Report`, does not follow it.

The same happens inside a `Batch`: the last status is read with a bare assertion, so `NewBatch(errors.New("first"), fmt.Errorf("ctx: %w", Status("late", 11)))` exits with `1` instead of `11`.

### Expected

A wrapped `StatusCoder` should be handled exactly like an unwrapped one: the message goes to `ErrWriter`, `Exiter` is called, and the status is preserved.
