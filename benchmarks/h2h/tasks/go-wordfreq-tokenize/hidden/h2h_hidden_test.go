package tests

import (
	"reflect"
	"testing"

	"example.com/wordfreq/wordfreq"
)

func TestHiddenTokenizeLowercases(t *testing.T) {
	got := wordfreq.Tokenize("Hello WORLD hello")
	want := []string{"hello", "world", "hello"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestHiddenTokenizeStripsPunctuation(t *testing.T) {
	got := wordfreq.Tokenize("The end. (Really!) well-known: yes? \"quoted\"")
	want := []string{"the", "end", "really", "well", "known", "yes", "quoted"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestHiddenTokenizeKeepsInternalApostrophes(t *testing.T) {
	got := wordfreq.Tokenize("Don't stop rock'n'roll, it's fine")
	want := []string{"don't", "stop", "rock'n'roll", "it's", "fine"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestHiddenTokenizeDropsEdgeApostrophes(t *testing.T) {
	got := wordfreq.Tokenize("'tis the dogs' 'quoted' ' '' x'")
	want := []string{"tis", "the", "dogs", "quoted", "x"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestHiddenTokenizeUnicodeAndDigits(t *testing.T) {
	got := wordfreq.Tokenize("ÉCOLE Straße, naïve 2024 r2d2!")
	want := []string{"école", "straße", "naïve", "2024", "r2d2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestHiddenTokenizeNoWords(t *testing.T) {
	if got := wordfreq.Tokenize(" ... !! "); len(got) != 0 {
		t.Fatalf("Tokenize = %q, want no words", got)
	}
}

func TestHiddenTopNMergesCaseAndPunctuation(t *testing.T) {
	got := wordfreq.TopN("Don't panic. don't PANIC! The end. the END", 10)
	want := []wordfreq.WordCount{
		{Word: "don't", Count: 2},
		{Word: "end", Count: 2},
		{Word: "panic", Count: 2},
		{Word: "the", Count: 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TopN = %v, want %v", got, want)
	}
}

func TestHiddenTopNTiesAlphabetical(t *testing.T) {
	text := "pear fig apple kiwi fig pear banana date cherry"
	want := []wordfreq.WordCount{
		{Word: "fig", Count: 2},
		{Word: "pear", Count: 2},
		{Word: "apple", Count: 1},
		{Word: "banana", Count: 1},
	}
	for i := 0; i < 20; i++ {
		got := wordfreq.TopN(text, 4)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("TopN = %v, want %v", got, want)
		}
	}
}

func TestHiddenTopNLargerThanDistinct(t *testing.T) {
	got := wordfreq.TopN("b a b", 50)
	want := []wordfreq.WordCount{{Word: "b", Count: 2}, {Word: "a", Count: 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TopN = %v, want %v", got, want)
	}
}

func TestHiddenTopNNonPositive(t *testing.T) {
	for _, n := range []int{0, -1, -100} {
		got := wordfreq.TopN("a b c a", n)
		if got == nil || len(got) != 0 {
			t.Fatalf("TopN(n=%d) = %#v, want empty non-nil slice", n, got)
		}
	}
}

func TestHiddenTopNEmptyText(t *testing.T) {
	got := wordfreq.TopN("", 3)
	if got == nil || len(got) != 0 {
		t.Fatalf("TopN on empty text = %#v, want empty non-nil slice", got)
	}
}
