package notes

import (
	"fmt"
	"strings"
)

// Handlers serves note requests from one Store.
type Handlers struct {
	store Store
}

// NewHandlers returns handlers backed by store.
func NewHandlers(store Store) *Handlers {
	return &Handlers{store: store}
}

// Create adds a note and returns "created <id>" or "error: <message>".
func (h *Handlers) Create(title, body string) string {
	n, err := h.store.Add(title, body)
	if err != nil {
		return "error: " + err.Error()
	}
	return fmt.Sprintf("created %d", n.ID)
}

// Show returns the full note or "error: <message>".
func (h *Handlers) Show(id int) string {
	n, err := h.store.Get(id)
	if err != nil {
		return "error: " + err.Error()
	}
	return FormatNote(n)
}

// List returns one summary line per note, or "no notes".
func (h *Handlers) List() string {
	all := h.store.List()
	if len(all) == 0 {
		return "no notes"
	}
	lines := make([]string, len(all))
	for i, n := range all {
		lines[i] = FormatSummary(n)
	}
	return strings.Join(lines, "\n")
}

// Delete removes a note and returns "deleted <id>" or "error: <message>".
func (h *Handlers) Delete(id int) string {
	if err := h.store.Delete(id); err != nil {
		return "error: " + err.Error()
	}
	return fmt.Sprintf("deleted %d", id)
}
