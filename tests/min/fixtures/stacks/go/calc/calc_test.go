package calc

import "testing"

func TestAdd(t *testing.T) {
	if (Calc{}).Add(2, 3) != 5 {
		t.Fatal("add")
	}
}
