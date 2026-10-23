package parmap

import "sync"

func Map(items []int, workers int, f func(int) int) []int {
	out := make([]int, len(items))
	var wg sync.WaitGroup
	for i, v := range items {
		wg.Add(1)
		go func(i, v int) {
			defer wg.Done()
			out[i] = f(v)
		}(i, v)
	}
	wg.Wait()
	return out
}
