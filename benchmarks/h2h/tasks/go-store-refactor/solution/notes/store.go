package notes

import (
	"fmt"
	"sort"
)

// Store keeps notes.
type Store interface {
	Add(title, body string) (Note, error)
	Get(id int) (Note, error)
	List() []Note
	Delete(id int) error
}

// MemStore is an in-memory Store. Each instance has its own notes and ids.
type MemStore struct {
	notes  map[int]Note
	nextID int
}

// NewMemStore returns an empty in-memory store whose ids start at 1.
func NewMemStore() *MemStore {
	return &MemStore{notes: map[int]Note{}, nextID: 1}
}

// Add stores a new note with a trimmed title and returns it. IDs start at 1
// and are never reused, even after a delete.
func (s *MemStore) Add(title, body string) (Note, error) {
	t, err := NormalizeTitle(title)
	if err != nil {
		return Note{}, err
	}
	n := Note{ID: s.nextID, Title: t, Body: body}
	s.notes[n.ID] = n
	s.nextID++
	return n, nil
}

// Get returns the note with the given id.
func (s *MemStore) Get(id int) (Note, error) {
	n, ok := s.notes[id]
	if !ok {
		return Note{}, fmt.Errorf("note %d: %w", id, ErrNotFound)
	}
	return n, nil
}

// List returns every note sorted by id.
func (s *MemStore) List() []Note {
	out := make([]Note, 0, len(s.notes))
	for _, n := range s.notes {
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Delete removes the note with the given id.
func (s *MemStore) Delete(id int) error {
	if _, ok := s.notes[id]; !ok {
		return fmt.Errorf("note %d: %w", id, ErrNotFound)
	}
	delete(s.notes, id)
	return nil
}
