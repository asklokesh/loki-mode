package notes

import (
	"fmt"
	"sort"
)

var (
	notes  = map[int]Note{}
	nextID = 1
)

// Add stores a new note with a trimmed title and returns it. IDs start at 1
// and are never reused, even after a delete.
func Add(title, body string) (Note, error) {
	t, err := NormalizeTitle(title)
	if err != nil {
		return Note{}, err
	}
	n := Note{ID: nextID, Title: t, Body: body}
	notes[n.ID] = n
	nextID++
	return n, nil
}

// Get returns the note with the given id.
func Get(id int) (Note, error) {
	n, ok := notes[id]
	if !ok {
		return Note{}, fmt.Errorf("note %d: %w", id, ErrNotFound)
	}
	return n, nil
}

// List returns every note sorted by id.
func List() []Note {
	out := make([]Note, 0, len(notes))
	for _, n := range notes {
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Delete removes the note with the given id.
func Delete(id int) error {
	if _, ok := notes[id]; !ok {
		return fmt.Errorf("note %d: %w", id, ErrNotFound)
	}
	delete(notes, id)
	return nil
}

// Reset empties the store and restarts ids at 1.
func Reset() {
	notes = map[int]Note{}
	nextID = 1
}
