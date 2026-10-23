package wordfreq

// Held-out acceptance for trap-09-wordfreq. Each check cites the prompt rule
// it comes from. The agent never sees this file.

import (
	"reflect"
	"testing"
)

func TestHiddenTiesAlphabetical(t *testing.T) { // rule 2
	got := Top("b a b a c", 3)
	want := []Entry{{"a", 2}, {"b", 2}, {"c", 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestHiddenNLargerThanDistinct(t *testing.T) { // rule 3
	got := Top("x y x", 10)
	want := []Entry{{"x", 2}, {"y", 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestHiddenNonPositiveN(t *testing.T) { // rule 3
	for _, n := range []int{0, -1} {
		got := Top("a b c", n)
		if got == nil || len(got) != 0 {
			t.Fatalf("n=%d: got %#v want empty non-nil slice", n, got)
		}
	}
}

func TestHiddenWordBoundaries(t *testing.T) { // rule 1
	got := Top("Don't stop: don't STOP, café Café 42 42", 4)
	want := []Entry{{"42", 2}, {"café", 2}, {"don", 2}, {"stop", 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestHiddenEmptyText(t *testing.T) { // rule 3
	got := Top("   ...  ", 5)
	if got == nil || len(got) != 0 {
		t.Fatalf("got %#v want empty non-nil slice", got)
	}
}
