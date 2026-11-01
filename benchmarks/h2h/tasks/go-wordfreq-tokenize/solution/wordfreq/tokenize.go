// Package wordfreq counts how often words appear in a piece of text.
package wordfreq

import (
	"strings"
	"unicode"
)

// Tokenize splits text into lowercase words. A word is a maximal run of
// letters, digits and ASCII apostrophes with leading and trailing apostrophes
// removed; runs that are empty after trimming are dropped.
func Tokenize(text string) []string {
	words := []string{}
	var current strings.Builder
	flush := func() {
		w := strings.Trim(current.String(), "'")
		if w != "" {
			words = append(words, strings.ToLower(w))
		}
		current.Reset()
	}
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '\'' {
			current.WriteRune(r)
			continue
		}
		flush()
	}
	flush()
	return words
}
