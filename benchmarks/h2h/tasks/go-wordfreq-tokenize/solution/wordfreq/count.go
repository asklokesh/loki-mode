package wordfreq

import "sort"

// WordCount is one word and how many times it occurs.
type WordCount struct {
	Word  string
	Count int
}

// TopN returns the n most frequent words in text, most frequent first, with
// ties broken by word in ascending order.
func TopN(text string, n int) []WordCount {
	if n <= 0 {
		return []WordCount{}
	}
	counts := map[string]int{}
	for _, w := range Tokenize(text) {
		counts[w]++
	}
	out := make([]WordCount, 0, len(counts))
	for w, c := range counts {
		out = append(out, WordCount{Word: w, Count: c})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Word < out[j].Word
	})
	if n < len(out) {
		out = out[:n]
	}
	return out
}
