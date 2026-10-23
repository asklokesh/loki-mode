package parmap

import "sync"

func Map(items []int, workers int, f func(int) int) []int {
	out := make([]int, len(items))
	if workers <= 0 {
		workers = 1
	}
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i, v := range items {
		wg.Add(1)
		sem <- struct{}{}
		go func(i, v int) {
			defer wg.Done()
			out[i] = f(v)
			<-sem
		}(i, v)
	}
	wg.Wait()
	return out
}
