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
		Name:    "add",
		Usage:   "add <text> [#tag ...]",
		Summary: "add a note",
		Run:     runAdd,
	})
}

// runAdd: words starting with # are tags (stored without the #), the other words joined by spaces are the text.
func runAdd(args []string, st *notes.Store, out io.Writer) error {
	var words, tags []string
	for _, a := range args {
		if strings.HasPrefix(a, "#") && len(a) > 1 {
			tags = append(tags, a[1:])
		} else {
			words = append(words, a)
		}
	}
	text := strings.TrimSpace(strings.Join(words, " "))
	if text == "" {
		return errors.New("usage: add <text> [#tag ...]")
	}
	n := st.Add(text, tags)
	fmt.Fprintf(out, "added %d\n", n.ID)
	return nil
}
