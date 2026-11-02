package tests

import (
	"testing"

	"example.com/mathx/mathx"
)

func TestAbs(t *testing.T) {
	if mathx.Abs(-3) != 3 || mathx.Abs(4) != 4 {
		t.Fatal("Abs")
	}
}

func TestClamp(t *testing.T) {
	if mathx.Clamp(5, 0, 3) != 3 || mathx.Clamp(-1, 0, 3) != 0 || mathx.Clamp(2, 0, 3) != 2 {
		t.Fatal("Clamp")
	}
}
