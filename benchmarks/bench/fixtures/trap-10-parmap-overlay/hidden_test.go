package parmap

// Held-out acceptance for trap-10-parmap. Each check cites the prompt rule it
// comes from. The agent never sees this file.

import (
	"sync/atomic"
	"testing"
	"time"
)

func peak(items []int, workers int) (int32, []int) {
	var cur, max int32
	got := Map(items, workers, func(x int) int {
		c := atomic.AddInt32(&cur, 1)
		for {
			m := atomic.LoadInt32(&max)
			if c <= m || atomic.CompareAndSwapInt32(&max, m, c) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		atomic.AddInt32(&cur, -1)
		return x * 2
	})
	return atomic.LoadInt32(&max), got
}

func seqItems(n int) []int {
	s := make([]int, n)
	for i := range s {
		s[i] = i
	}
	return s
}

func TestHiddenResultIndexMatchesItemIndex(t *testing.T) { // rule 1
	for _, workers := range []int{1, 3, 8, 64} {
		items := make([]int, 40)
		for i := range items {
			items[i] = (i * 7) % 11
		}
		got := Map(items, workers, func(x int) int {
			time.Sleep(time.Duration(x) * time.Millisecond)
			return x*3 + 1
		})
		if len(got) != len(items) {
			t.Fatalf("workers %d: len %d want %d", workers, len(got), len(items))
		}
		for i, v := range items {
			if got[i] != v*3+1 {
				t.Fatalf("workers %d: result[%d] = %d want %d", workers, i, got[i], v*3+1)
			}
		}
	}
}

func TestHiddenAtMostWorkersConcurrent(t *testing.T) { // rule 2
	max, got := peak(seqItems(12), 3)
	if max > 3 {
		t.Fatalf("saw %d concurrent calls, limit 3", max)
	}
	for i, v := range got {
		if v != i*2 {
			t.Fatalf("result[%d]=%d want %d", i, v, i*2)
		}
	}
}

func TestHiddenRunsConcurrently(t *testing.T) { // rule 3
	max, _ := peak(seqItems(12), 3)
	if max < 2 {
		t.Fatalf("saw %d concurrent calls with 3 workers, want at least 2", max)
	}
}

func TestHiddenNonPositiveWorkersMeansOne(t *testing.T) { // rule 4
	for _, w := range []int{0, -3} {
		max, got := peak(seqItems(4), w)
		if max != 1 {
			t.Fatalf("workers=%d: saw %d concurrent calls, want 1", w, max)
		}
		if len(got) != 4 {
			t.Fatalf("workers=%d: got %d results", w, len(got))
		}
	}
}

func TestHiddenEmptyInput(t *testing.T) { // rule 5
	for _, in := range [][]int{nil, {}} {
		got := Map(in, 2, func(x int) int { return x })
		if got == nil || len(got) != 0 {
			t.Fatalf("got %#v want empty non-nil slice", got)
		}
	}
}
