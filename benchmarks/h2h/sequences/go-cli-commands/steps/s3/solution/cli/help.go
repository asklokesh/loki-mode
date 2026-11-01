package cli

import (
	"errors"
	"fmt"
	"io"
	"sort"

	"example.com/notes/notes"
)

func init() {
	register(Command{
		Name:    "help",
		Usage:   "help",
		Summary: "show this help",
		Run:     runHelp,
	})
}

// runHelp lists every registered command, sorted by name, with usages padded to one column.
func runHelp(args []string, _ *notes.Store, out io.Writer) error {
	if len(args) != 0 {
		return errors.New("usage: help")
	}
	names := make([]string, 0, len(commands))
	width := 0
	for name, c := range commands {
		names = append(names, name)
		if len(c.Usage) > width {
			width = len(c.Usage)
		}
	}
	sort.Strings(names)
	fmt.Fprint(out, "usage: notes <command> [args]\n\ncommands:\n")
	for _, name := range names {
		c := commands[name]
		fmt.Fprintf(out, "  %-*s  %s\n", width, c.Usage, c.Summary)
	}
	return nil
}
