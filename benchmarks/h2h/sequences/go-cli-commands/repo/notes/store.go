// Package notes is an in-memory note store.
package notes

// Note is one note. IDs start at 1 and are never reused.
type Note struct {
	ID   int
	Text string
	Tags []string
	Done bool
}

// Store keeps notes in ID order.
type Store struct {
	notes  []Note
	nextID int
}

func NewStore() *Store {
	return &Store{nextID: 1}
}

// Add stores a new note and returns it.
func (s *Store) Add(text string, tags []string) Note {
	n := Note{ID: s.nextID, Text: text, Tags: append([]string(nil), tags...)}
	s.nextID++
	s.notes = append(s.notes, n)
	return n
}

// All returns a copy of every note in ID order.
func (s *Store) All() []Note {
	return append([]Note(nil), s.notes...)
}

// Get returns the note with the given ID.
func (s *Store) Get(id int) (Note, bool) {
	for _, n := range s.notes {
		if n.ID == id {
			return n, true
		}
	}
	return Note{}, false
}

// SetDone marks a note done or not done; false if there is no such note.
func (s *Store) SetDone(id int, done bool) bool {
	for i := range s.notes {
		if s.notes[i].ID == id {
			s.notes[i].Done = done
			return true
		}
	}
	return false
}

// Remove deletes a note; false if there is no such note.
func (s *Store) Remove(id int) bool {
	for i := range s.notes {
		if s.notes[i].ID == id {
			s.notes = append(s.notes[:i], s.notes[i+1:]...)
			return true
		}
	}
	return false
}
