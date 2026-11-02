package tests

import (
	"testing"

	"example.com/mathx/mathx"
)

func TestHiddenLcm(t *testing.T) {
	cases := [][3]int{{4, 6, 12}, {-3, 5, 15}, {3, -5, 15}, {0, 9, 0}, {9, 0, 0}, {7, 7, 7}, {21, 6, 42}}
	for _, c := range cases {
		if got := mathx.Lcm(c[0], c[1]); got != c[2] {
			t.Errorf("Lcm(%d, %d) = %d, want %d", c[0], c[1], got, c[2])
		}
	}
}

func TestHiddenLcmRegistered(t *testing.T) {
	f, ok := mathx.Funcs["Lcm"].(func(int, int) int)
	if !ok || f(4, 6) != 12 {
		t.Fatal("Lcm is not registered in mathx.Funcs")
	}
}
