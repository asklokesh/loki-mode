package flags

import "testing"

func TestLokiProbe(t *testing.T) {
	lokiProbe("p1", "FlagLine for --output with short alias o", func() any {
		return FlagLine(Flag{Name: "output", Short: "o", Usage: "write to file"})
	})
	lokiProbe("p2", "Help with one aliased and one plain flag", func() any {
		return Help("tool", []Flag{{Name: "verbose", Usage: "print more"}, {Name: "output", Short: "o", Usage: "write to file"}})
	})
	lokiProbe("k1", "FlagLine without a short alias", func() any { return FlagLine(Flag{Name: "verbose", Usage: "print more"}) })
	lokiProbe("k2", "FlagLine with a default and no short alias", func() any {
		return FlagLine(Flag{Name: "count", Usage: "number of runs", Default: "3"})
	})
	lokiProbe("k3", "MissingError for --output with short alias o", func() any { return MissingError(Flag{Name: "output", Short: "o"}) })
	lokiProbe("k4", "Lookup of an unknown flag", func() any { f, err := Lookup([]Flag{{Name: "output", Short: "o"}}, "--nope")
		return []any{f, err} })
	lokiProbe("k5", "Lookup by short name", func() any { f, err := Lookup([]Flag{{Name: "output", Short: "o"}}, "-o")
		return []any{f, err} })
	lokiProbe("k6", "MissingError without a short alias", func() any { return MissingError(Flag{Name: "token"}) })
}
