package notes

import (
	"fmt"
	"strings"
)

// HandleCreate adds a note and returns "created <id>" or "error: <message>".
func HandleCreate(title, body string) string {
	n, err := Add(title, body)
	if err != nil {
		return "error: " + err.Error()
	}
	return fmt.Sprintf("created %d", n.ID)
}

// HandleShow returns the full note or "error: <message>".
func HandleShow(id int) string {
	n, err := Get(id)
	if err != nil {
		return "error: " + err.Error()
	}
	return FormatNote(n)
}

// HandleList returns one summary line per note, or "no notes".
func HandleList() string {
	all := List()
	if len(all) == 0 {
		return "no notes"
	}
	lines := make([]string, len(all))
	for i, n := range all {
		lines[i] = FormatSummary(n)
	}
	return strings.Join(lines, "\n")
}

// HandleDelete removes a note and returns "deleted <id>" or "error: <message>".
func HandleDelete(id int) string {
	if err := Delete(id); err != nil {
		return "error: " + err.Error()
	}
	return fmt.Sprintf("deleted %d", id)
}
