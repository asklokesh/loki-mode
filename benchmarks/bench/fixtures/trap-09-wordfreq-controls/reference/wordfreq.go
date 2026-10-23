package wordfreq

import (
	"sort"
	"strings"
	"unicode"
)

type Entry struct {
	Word  string
	Count int
}

func Top(text string, n int) []Entry {
	counts := map[string]int{}
	words := strings.FieldsFunc(text, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for _, w := range words {
		counts[strings.ToLower(w)]++
	}
	all := make([]Entry, 0, len(counts))
	for w, c := range counts {
		all = append(all, Entry{w, c})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Count != all[j].Count {
			return all[i].Count > all[j].Count
		}
		return all[i].Word < all[j].Word
	})
	if n <= 0 {
		return []Entry{}
	}
	if n < len(all) {
		all = all[:n]
	}
	return all
}
