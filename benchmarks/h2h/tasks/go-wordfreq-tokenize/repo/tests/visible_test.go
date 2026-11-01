package tests

import (
	"reflect"
	"testing"

	"example.com/wordfreq/wordfreq"
)

func TestTokenizeSplitsOnSpaces(t *testing.T) {
	got := wordfreq.Tokenize("the quick  brown\tfox")
	want := []string{"the", "quick", "brown", "fox"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestTopNOrdersByCount(t *testing.T) {
	got := wordfreq.TopN("b a b c b c", 3)
	want := []wordfreq.WordCount{{Word: "b", Count: 3}, {Word: "c", Count: 2}, {Word: "a", Count: 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TopN = %v, want %v", got, want)
	}
}

func TestTopNLimit(t *testing.T) {
	got := wordfreq.TopN("x x x y y z", 1)
	want := []wordfreq.WordCount{{Word: "x", Count: 3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TopN = %v, want %v", got, want)
	}
}
