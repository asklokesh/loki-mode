package tests

import (
	"errors"
	"reflect"
	"testing"

	"example.com/notes/notes"
)

func TestHiddenMemStoreAddGet(t *testing.T) {
	var s notes.Store = notes.NewMemStore()
	n, err := s.Add("  Groceries  ", "milk\n")
	if err != nil {
		t.Fatal(err)
	}
	want := notes.Note{ID: 1, Title: "Groceries", Body: "milk\n"}
	if n != want {
		t.Fatalf("Add = %+v, want %+v", n, want)
	}
	got, err := s.Get(1)
	if err != nil || got != want {
		t.Fatalf("Get(1) = %+v, %v", got, err)
	}
}

func TestHiddenMemStoreEmptyTitle(t *testing.T) {
	s := notes.NewMemStore()
	if _, err := s.Add(" \t ", "body"); !errors.Is(err, notes.ErrTitleRequired) {
		t.Fatalf("err = %v, want ErrTitleRequired", err)
	}
	if got := s.List(); len(got) != 0 {
		t.Fatalf("a rejected note was stored: %+v", got)
	}
	n, err := s.Add("first", "")
	if err != nil || n.ID != 1 {
		t.Fatalf("a rejected Add must not use up an id: %+v, %v", n, err)
	}
}

func TestHiddenMemStoreMissing(t *testing.T) {
	s := notes.NewMemStore()
	_, err := s.Get(7)
	if !errors.Is(err, notes.ErrNotFound) || err.Error() != "note 7: note not found" {
		t.Fatalf("Get(7) err = %v", err)
	}
	err = s.Delete(9)
	if !errors.Is(err, notes.ErrNotFound) || err.Error() != "note 9: note not found" {
		t.Fatalf("Delete(9) err = %v", err)
	}
}

func TestHiddenMemStoreListSortedAndNonNil(t *testing.T) {
	s := notes.NewMemStore()
	if got := s.List(); got == nil || len(got) != 0 {
		t.Fatalf("List on an empty store = %#v, want empty non-nil", got)
	}
	for _, title := range []string{"c", "a", "e", "b", "d", "f", "g", "h"} {
		if _, err := s.Add(title, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Delete(3); err != nil {
		t.Fatal(err)
	}
	var ids []int
	for _, n := range s.List() {
		ids = append(ids, n.ID)
	}
	if !reflect.DeepEqual(ids, []int{1, 2, 4, 5, 6, 7, 8}) {
		t.Fatalf("List ids = %v", ids)
	}
}

func TestHiddenMemStoreIDsNotReused(t *testing.T) {
	s := notes.NewMemStore()
	s.Add("a", "")
	s.Add("b", "")
	if err := s.Delete(2); err != nil {
		t.Fatal(err)
	}
	n, _ := s.Add("c", "")
	if n.ID != 3 {
		t.Fatalf("new id after deleting 2 = %d, want 3", n.ID)
	}
}

func TestHiddenMemStoresAreIsolated(t *testing.T) {
	a, b := notes.NewMemStore(), notes.NewMemStore()
	a.Add("only in a", "")
	a.Add("also in a", "")
	if got := b.List(); len(got) != 0 {
		t.Fatalf("store b sees notes from store a: %+v", got)
	}
	n, err := b.Add("first in b", "")
	if err != nil || n.ID != 1 {
		t.Fatalf("ids must start at 1 in every store: %+v, %v", n, err)
	}
	if _, err := a.Get(2); err != nil {
		t.Fatalf("store a lost its note: %v", err)
	}
	if _, err := b.Get(2); !errors.Is(err, notes.ErrNotFound) {
		t.Fatalf("store b found a note it never had: %v", err)
	}
}

func TestHiddenHandlersFlow(t *testing.T) {
	h := notes.NewHandlers(notes.NewMemStore())
	if got := h.List(); got != "no notes" {
		t.Fatalf("List on empty = %q", got)
	}
	if got := h.Create("  Plan ", "step one"); got != "created 1" {
		t.Fatalf("Create = %q", got)
	}
	if got := h.Create("Bare", ""); got != "created 2" {
		t.Fatalf("Create = %q", got)
	}
	if got := h.Create("   ", "x"); got != "error: title is required" {
		t.Fatalf("Create with blank title = %q", got)
	}
	if got := h.Show(1); got != "#1 Plan\nstep one" {
		t.Fatalf("Show(1) = %q", got)
	}
	if got := h.Show(2); got != "#2 Bare" {
		t.Fatalf("Show(2) = %q", got)
	}
	if got := h.List(); got != "#1 Plan\n#2 Bare" {
		t.Fatalf("List = %q", got)
	}
	if got := h.Delete(1); got != "deleted 1" {
		t.Fatalf("Delete(1) = %q", got)
	}
	if got := h.Delete(1); got != "error: note 1: note not found" {
		t.Fatalf("second Delete(1) = %q", got)
	}
	if got := h.Show(5); got != "error: note 5: note not found" {
		t.Fatalf("Show(5) = %q", got)
	}
	if got := h.List(); got != "#2 Bare" {
		t.Fatalf("List after delete = %q", got)
	}
}

func TestHiddenHandlersAreIsolated(t *testing.T) {
	h1 := notes.NewHandlers(notes.NewMemStore())
	h2 := notes.NewHandlers(notes.NewMemStore())
	h1.Create("one", "")
	if got := h2.List(); got != "no notes" {
		t.Fatalf("h2 sees h1's notes: %q", got)
	}
	if got := h2.Create("two", ""); got != "created 1" {
		t.Fatalf("h2 Create = %q", got)
	}
}

type fakeStore struct {
	added []string
}

func (f *fakeStore) Add(title, body string) (notes.Note, error) {
	f.added = append(f.added, title)
	if title == "fail" {
		return notes.Note{}, errors.New("disk full")
	}
	return notes.Note{ID: 42, Title: title, Body: body}, nil
}

func (f *fakeStore) Get(id int) (notes.Note, error) {
	return notes.Note{ID: id, Title: "fake", Body: "from fake"}, nil
}

func (f *fakeStore) List() []notes.Note {
	return []notes.Note{{ID: 9, Title: "z"}, {ID: 8, Title: "y"}}
}

func (f *fakeStore) Delete(id int) error {
	return errors.New("read only")
}

func TestHiddenHandlersUseInjectedStore(t *testing.T) {
	f := &fakeStore{}
	h := notes.NewHandlers(f)
	if got := h.Create("x", "b"); got != "created 42" {
		t.Fatalf("Create = %q", got)
	}
	if got := h.Create("fail", ""); got != "error: disk full" {
		t.Fatalf("Create with failing store = %q", got)
	}
	if !reflect.DeepEqual(f.added, []string{"x", "fail"}) {
		t.Fatalf("store.Add calls = %v", f.added)
	}
	if got := h.Show(3); got != "#3 fake\nfrom fake" {
		t.Fatalf("Show = %q", got)
	}
	if got := h.List(); got != "#9 z\n#8 y" {
		t.Fatalf("List = %q", got)
	}
	if got := h.Delete(1); got != "error: read only" {
		t.Fatalf("Delete = %q", got)
	}
}
