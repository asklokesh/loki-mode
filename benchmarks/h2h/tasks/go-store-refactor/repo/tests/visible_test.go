package tests

import (
	"errors"
	"testing"

	"example.com/notes/notes"
)

func TestNormalizeTitle(t *testing.T) {
	got, err := notes.NormalizeTitle("  Groceries \t")
	if err != nil || got != "Groceries" {
		t.Fatalf("NormalizeTitle = %q, %v", got, err)
	}
	if _, err := notes.NormalizeTitle("   "); !errors.Is(err, notes.ErrTitleRequired) {
		t.Fatalf("err = %v, want ErrTitleRequired", err)
	}
}

func TestFormatNote(t *testing.T) {
	n := notes.Note{ID: 3, Title: "Plan", Body: "step one"}
	if got := notes.FormatNote(n); got != "#3 Plan\nstep one" {
		t.Fatalf("FormatNote = %q", got)
	}
	if got := notes.FormatNote(notes.Note{ID: 4, Title: "Bare"}); got != "#4 Bare" {
		t.Fatalf("FormatNote without body = %q", got)
	}
	if got := notes.FormatSummary(n); got != "#3 Plan" {
		t.Fatalf("FormatSummary = %q", got)
	}
}

func TestErrorMessages(t *testing.T) {
	if notes.ErrNotFound.Error() != "note not found" {
		t.Fatalf("ErrNotFound = %q", notes.ErrNotFound.Error())
	}
	if notes.ErrTitleRequired.Error() != "title is required" {
		t.Fatalf("ErrTitleRequired = %q", notes.ErrTitleRequired.Error())
	}
}
