package tests

import (
	"testing"

	"example.com/mathx/mathx"
)

func TestHiddenIsPrime(t *testing.T) {
	primes := map[int]bool{2: true, 3: true, 5: true, 97: true, 7919: true, 1: false, 0: false, -7: false, 91: false, 4: false, 7917: false}
	for n, want := range primes {
		if got := mathx.IsPrime(n); got != want {
			t.Errorf("IsPrime(%d) = %v, want %v", n, got, want)
		}
	}
}

func TestHiddenIsPrimeRegistered(t *testing.T) {
	f, ok := mathx.Funcs["IsPrime"].(func(int) bool)
	if !ok || !f(13) {
		t.Fatal("IsPrime is not registered in mathx.Funcs")
	}
}
