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
	var order []string
	words := strings.FieldsFunc(text, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for _, w := range words {
		w = strings.ToLower(w)
		if counts[w] == 0 {
			order = append(order, w)
		}
		counts[w]++
	}
	all := make([]Entry, 0, len(order))
	for _, w := range order {
		all = append(all, Entry{w, counts[w]})
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].Count > all[j].Count })
	if n <= 0 {
		return nil
	}
	if n < len(all) {
		all = all[:n]
	}
	return all
}
