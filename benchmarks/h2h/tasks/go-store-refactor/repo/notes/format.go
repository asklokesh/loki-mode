// Package notes is a tiny note keeping service.
package notes

import (
	"errors"
	"fmt"
	"strings"
)

// Note is one stored note.
type Note struct {
	ID    int
	Title string
	Body  string
}

// ErrNotFound is wrapped by every error about a missing note.
var ErrNotFound = errors.New("note not found")

// ErrTitleRequired is returned when a title is empty after trimming.
var ErrTitleRequired = errors.New("title is required")

// NormalizeTitle trims surrounding whitespace and rejects an empty title.
func NormalizeTitle(title string) (string, error) {
	t := strings.TrimSpace(title)
	if t == "" {
		return "", ErrTitleRequired
	}
	return t, nil
}

// FormatSummary renders a note as one list line: "#3 Title".
func FormatSummary(n Note) string {
	return fmt.Sprintf("#%d %s", n.ID, n.Title)
}

// FormatNote renders a full note: the summary line, then the body.
func FormatNote(n Note) string {
	if n.Body == "" {
		return FormatSummary(n)
	}
	return FormatSummary(n) + "\n" + n.Body
}
