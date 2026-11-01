package limiter

import "testing"

func TestAllowOnce(t *testing.T) {
	l := New(1, 1, System)
	if !l.Allow() {
		t.Fatal("first call must pass")
	}
}
