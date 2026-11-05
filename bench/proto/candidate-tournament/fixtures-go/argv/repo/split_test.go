package argv

import (
	"reflect"
	"testing"
)

func TestSplit_FlagsAndArgs(t *testing.T) {
	p := Split([]string{"-v", "a", "b"})
	if !reflect.DeepEqual(p.Flags, []string{"-v"}) || !reflect.DeepEqual(p.Args, []string{"a", "b"}) {
		t.Fatalf("%+v", p)
	}
}

func TestSplit_OperandsKeepWhitespace(t *testing.T) {
	p := Split([]string{" a ", "b"})
	if !reflect.DeepEqual(p.Args, []string{" a ", "b"}) {
		t.Fatalf("%+v", p)
	}
}
