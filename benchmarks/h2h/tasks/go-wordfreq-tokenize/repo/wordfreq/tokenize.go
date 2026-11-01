// Package wordfreq counts how often words appear in a piece of text.
package wordfreq

import "unicode"

// Tokenize splits text into the words that TopN counts.
func Tokenize(text string) []string {
	words := []string{}
	current := []rune{}
	for _, r := range text {
		if unicode.IsSpace(r) || r == ',' || r == ';' {
			if len(current) > 0 {
				words = append(words, string(current))
				current = current[:0]
			}
			continue
		}
		current = append(current, r)
	}
	if len(current) > 0 {
		words = append(words, string(current))
	}
	return words
}
