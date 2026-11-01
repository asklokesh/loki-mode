package cli

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"example.com/notes/notes"
)

func init() {
	register(Command{
		Name:    "list",
		Usage:   "list [#tag]",
		Summary: "list notes, optionally only those with a tag",
		Run:     runList,
	})
}

func runList(args []string, st *notes.Store, out io.Writer) error {
	tag := ""
	if len(args) > 1 || (len(args) == 1 && (!strings.HasPrefix(args[0], "#") || len(args[0]) < 2)) {
		return errors.New("usage: list [#tag]")
	}
	if len(args) == 1 {
		tag = args[0][1:]
	}
	shown := 0
	for _, n := range st.All() {
		if tag != "" && !hasTag(n, tag) {
			continue
		}
		mark := " "
		if n.Done {
			mark = "x"
		}
		line := fmt.Sprintf("%d. [%s] %s", n.ID, mark, n.Text)
		for _, t := range n.Tags {
			line += " #" + t
		}
		fmt.Fprintln(out, line)
		shown++
	}
	if shown == 0 {
		fmt.Fprintln(out, "no notes")
	}
	return nil
}

func hasTag(n notes.Note, tag string) bool {
	for _, t := range n.Tags {
		if t == tag {
			return true
		}
	}
	return false
}
