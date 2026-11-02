package tests

import (
	"testing"

	"example.com/mathx/mathx"
)

func TestHiddenPow(t *testing.T) {
	cases := [][3]int{{2, 10, 1024}, {-3, 3, -27}, {0, 0, 1}, {5, 0, 1}, {0, 3, 0}, {7, 1, 7}, {-2, 4, 16}}
	for _, c := range cases {
		got, err := mathx.Pow(c[0], c[1])
		if err != nil || got != c[2] {
			t.Errorf("Pow(%d, %d) = %d, %v, want %d", c[0], c[1], got, err, c[2])
		}
	}
	got, err := mathx.Pow(2, -1)
	if err == nil || err.Error() != "negative exponent" || got != 0 {
		t.Errorf("Pow(2, -1) = %d, %v", got, err)
	}
}

func TestHiddenPowRegistered(t *testing.T) {
	f, ok := mathx.Funcs["Pow"].(func(int, int) (int, error))
	if !ok {
		t.Fatal("Pow is not registered in mathx.Funcs")
	}
	if v, err := f(3, 2); err != nil || v != 9 {
		t.Fatal("registered Pow is wrong")
	}
}
