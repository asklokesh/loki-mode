A lone "-" drops every argument after it

In `Parser.Parse`, a lone `-` is appended and then a `break` drops every argument after it.

`prog - foo bar` gives Pos `[-]`; expected `[- foo bar]`.

The dash branch looks like this:

```go
if firstArg == "-" {
	p.Pos = append(p.Pos, firstArg)
	break
}
```

Arguments after the dash should still be parsed: use `continue` after appending just `firstArg`.
