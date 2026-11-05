package flags

// Private oracle: scored after the differential runs, never shown to any prompt. It plays the maintainer's hidden test:
// the requested change plus the neighbouring behavior the maintainer expects to stay put.

import "testing"

func TestOracleShortFirstInHelp(t *testing.T) {
	if got := FlagLine(Flag{Name: "output", Short: "o", Usage: "write to file"}); got != "  -o, --output\twrite to file" {
		t.Fatalf("FlagLine = %q", got)
	}
	if got := FlagLine(Flag{Name: "count", Short: "n", Usage: "runs", Default: "3"}); got != "  -n, --count\truns (default: 3)" {
		t.Fatalf("FlagLine default = %q", got)
	}
	want := "Usage: tool [flags]\n\nFlags:\n  -o, --output\twrite to file\n  --verbose\tprint more\n"
	if got := Help("tool", []Flag{{Name: "verbose", Usage: "print more"}, {Name: "output", Short: "o", Usage: "write to file"}}); got != want {
		t.Fatalf("Help = %q", got)
	}
}

func TestOracleErrorsUnchanged(t *testing.T) {
	if got := MissingError(Flag{Name: "output", Short: "o"}).Error(); got != "required flag --output, -o not set" {
		t.Fatalf("MissingError = %q", got)
	}
	if _, err := Lookup(nil, "--nope"); err == nil || err.Error() != "unknown flag: --nope" {
		t.Fatalf("Lookup error = %v", err)
	}
}
