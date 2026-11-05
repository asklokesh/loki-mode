package argv

import (
	"reflect"
	"testing"
)

func TestParseMixed(t *testing.T) {
	var p Parser
	p.Parse([]string{"a", "--verbose=1", "b"})
	if !reflect.DeepEqual(p.Pos, []string{"a", "b"}) || p.Flags["verbose"] != "1" {
		t.Fatalf("got %v %v", p.Pos, p.Flags)
	}
}

func TestParsePositionalKeepWhitespace(t *testing.T) {
	var p Parser
	p.Parse([]string{" a ", "b"})
	if !reflect.DeepEqual(p.Pos, []string{" a ", "b"}) {
		t.Fatalf("got %q", p.Pos)
	}
}
