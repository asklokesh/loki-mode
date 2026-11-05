// Package flags renders help text and errors for command-line flags.
package flags

import (
	"fmt"
	"sort"
	"strings"
)

// Flag describes one command-line flag.
type Flag struct {
	Name     string
	Short    string
	Usage    string
	Default  string
	Required bool
}

// names renders the flag's spellings, long form first.
func names(f Flag) string {
	if f.Short == "" {
		return "--" + f.Name
	}
	return "--" + f.Name + ", -" + f.Short
}

// FlagLine is one line of the help listing.
func FlagLine(f Flag) string {
	line := "  " + names(f) + "\t" + f.Usage
	if f.Default != "" {
		line += fmt.Sprintf(" (default: %s)", f.Default)
	}
	return line
}

// Help renders the usage line and the flag listing, flags sorted by name.
func Help(prog string, fs []Flag) string {
	sorted := append([]Flag(nil), fs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	var b strings.Builder
	fmt.Fprintf(&b, "Usage: %s [flags]\n\nFlags:\n", prog)
	for _, f := range sorted {
		b.WriteString(FlagLine(f))
		b.WriteString("\n")
	}
	return b.String()
}

// MissingError reports a required flag that was not set.
func MissingError(f Flag) error {
	return fmt.Errorf("required flag %s not set", names(f))
}

// Lookup finds a flag by its long or short name, with or without dashes.
func Lookup(fs []Flag, name string) (Flag, error) {
	n := strings.TrimLeft(name, "-")
	for _, f := range fs {
		if f.Name == n || (f.Short != "" && f.Short == n) {
			return f, nil
		}
	}
	return Flag{}, fmt.Errorf("unknown flag: %s", name)
}
