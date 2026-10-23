package parmap

import (
	"reflect"
	"testing"
)

func TestVisibleResultsInOrder(t *testing.T) {
	in := []int{1, 2, 3, 4, 5, 6}
	got := Map(in, 3, func(x int) int { return x * x })
	want := []int{1, 4, 9, 16, 25, 36}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestVisibleSingleWorker(t *testing.T) {
	got := Map([]int{5, 6}, 1, func(x int) int { return x + 1 })
	if !reflect.DeepEqual(got, []int{6, 7}) {
		t.Fatalf("got %v", got)
	}
}
