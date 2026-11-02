// Package cli implements the notes command line: notes <command> [args].
package cli

import (
	"errors"
	"fmt"
	"io"

	"example.com/notes/notes"
)

// Command is one subcommand. Each command lives in its own file and registers itself in init.
type Command struct {
	Name    string
	Usage   string // e.g. "add <text> [#tag ...]"
	Summary string // one line for help output
	Run     func(args []string, st *notes.Store, out io.Writer) error
}

var commands = map[string]Command{}

func register(c Command) {
	commands[c.Name] = c
}

// Run dispatches args[0] to its command with the remaining args.
func Run(args []string, st *notes.Store, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: notes <command> [args]")
	}
	c, ok := commands[args[0]]
	if !ok {
		return fmt.Errorf("unknown command %q", args[0])
	}
	return c.Run(args[1:], st, out)
}
