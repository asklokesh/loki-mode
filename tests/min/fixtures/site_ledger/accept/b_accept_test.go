package argv

import (
	"reflect"
	"testing"
)

func TestAcceptDashKeepsRest(t *testing.T) {
	var p Parser
	p.Parse([]string{"-", "foo", "--verbose=1", "bar"})
	if !reflect.DeepEqual(p.Pos, []string{"-", "foo", "bar"}) || p.Flags["verbose"] != "1" {
		t.Fatalf("got %q %v", p.Pos, p.Flags)
	}
}

func TestAcceptDashRawValue(t *testing.T) {
	var p Parser
	p.Parse([]string{" - ", "x"})
	if !reflect.DeepEqual(p.Pos, []string{" - ", "x"}) {
		t.Fatalf("got %q", p.Pos)
	}
}
