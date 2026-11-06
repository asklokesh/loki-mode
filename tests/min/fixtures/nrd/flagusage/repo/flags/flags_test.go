package flags

import (
	"strings"
	"testing"
)

func TestHelpHeader(t *testing.T) {
	got := Help("tool", []Flag{{Name: "verbose", Usage: "print more"}})
	if !strings.HasPrefix(got, "Usage: tool [flags]\n\nFlags:\n") {
		t.Fatalf("Help = %q", got)
	}
}

func TestFlagLineWithoutShort(t *testing.T) {
	if got := FlagLine(Flag{Name: "verbose", Usage: "print more"}); got != "  --verbose\tprint more" {
		t.Fatalf("FlagLine = %q", got)
	}
}

func TestLookupByEitherName(t *testing.T) {
	fs := []Flag{{Name: "output", Short: "o"}}
	for _, n := range []string{"--output", "-o", "output"} {
		if f, err := Lookup(fs, n); err != nil || f.Name != "output" {
			t.Fatalf("Lookup(%q) = %v, %v", n, f, err)
		}
	}
	if _, err := Lookup(fs, "--nope"); err == nil {
		t.Fatal("Lookup(--nope) should fail")
	}
}
