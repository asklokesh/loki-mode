package wordfreq

import (
	"reflect"
	"testing"
)

func TestVisibleCounts(t *testing.T) {
	got := Top("the cat and the dog and the bird", 2)
	want := []Entry{{"the", 3}, {"and", 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestVisibleCaseInsensitive(t *testing.T) {
	got := Top("Go go GO stop", 1)
	want := []Entry{{"go", 3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}
