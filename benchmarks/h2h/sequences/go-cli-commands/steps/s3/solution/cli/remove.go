package cli

import (
	"fmt"
	"io"

	"example.com/notes/notes"
)

func init() {
	register(Command{
		Name:    "remove",
		Usage:   "remove <id>",
		Summary: "delete a note",
		Run:     runRemove,
	})
}

func runRemove(args []string, st *notes.Store, out io.Writer) error {
	id, err := parseNoteID(args, "usage: remove <id>")
	if err != nil {
		return err
	}
	if !st.Remove(id) {
		return fmt.Errorf("no note with id %d", id)
	}
	fmt.Fprintf(out, "removed %d\n", id)
	return nil
}
