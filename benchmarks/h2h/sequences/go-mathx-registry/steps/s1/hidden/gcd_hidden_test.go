package tests

import (
	"testing"

	"example.com/mathx/mathx"
)

func TestHiddenGcd(t *testing.T) {
	cases := [][3]int{{12, 18, 6}, {-12, 18, 6}, {12, -18, 6}, {7, 0, 7}, {0, 7, 7}, {0, 0, 0}, {17, 5, 1}, {-4, -6, 2}}
	for _, c := range cases {
		if got := mathx.Gcd(c[0], c[1]); got != c[2] {
			t.Errorf("Gcd(%d, %d) = %d, want %d", c[0], c[1], got, c[2])
		}
	}
}

func TestHiddenGcdRegistered(t *testing.T) {
	f, ok := mathx.Funcs["Gcd"].(func(int, int) int)
	if !ok || f(8, 12) != 4 {
		t.Fatal("Gcd is not registered in mathx.Funcs")
	}
}
