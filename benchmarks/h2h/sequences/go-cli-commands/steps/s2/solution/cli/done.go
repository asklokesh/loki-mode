package cli

import (
	"errors"
	"fmt"
	"io"
	"strconv"

	"example.com/notes/notes"
)

func init() {
	register(Command{
		Name:    "done",
		Usage:   "done <id>",
		Summary: "mark a note as done",
		Run:     runDone,
	})
}

func runDone(args []string, st *notes.Store, out io.Writer) error {
	id, err := parseNoteID(args, "usage: done <id>")
	if err != nil {
		return err
	}
	if !st.SetDone(id, true) {
		return fmt.Errorf("no note with id %d", id)
	}
	fmt.Fprintf(out, "done %d\n", id)
	return nil
}

// parseNoteID accepts exactly one argument that is a positive decimal integer.
func parseNoteID(args []string, usage string) (int, error) {
	if len(args) != 1 {
		return 0, errors.New(usage)
	}
	for _, r := range args[0] {
		if r < '0' || r > '9' {
			return 0, errors.New(usage)
		}
	}
	id, err := strconv.Atoi(args[0])
	if err != nil || id < 1 {
		return 0, errors.New(usage)
	}
	return id, nil
}
