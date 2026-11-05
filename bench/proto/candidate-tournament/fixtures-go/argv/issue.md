# A bare "-" argument silently discards all following arguments in Split

## Summary

In `Split`, the branch handling a lone `-` argument appends it to `p.Args` and then executes a plain `break`, which exits the whole loop. Every argument after the `-` is dropped without error: `tool - foo bar` ends up with `Args` == `["-"]`.

## Location

- File: `split.go`
- Function: `Split`

```go
	// this is same as firstArg == "-"
	if len(firstArg) == 1 {
		p.Args = append(p.Args, firstArg)
		break
	}
```

## Expected

The arguments are retained: `["-", "foo", "bar"]`, matching Go's stdlib `flag`, which treats a bare `-` like an ordinary operand. Flags after the `-` keep working as they do after any other operand.
