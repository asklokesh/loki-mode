package argv

// PRIVATE ORACLE: scored only after the pick, never shown to any prompt. It checks only what the issue and the
// repo's own conventions decide: the issue's example, flags after a bare "-", and that a bare "-" is an ordinary
// operand, which keeps its exact spelling like every other operand (TestSplit_OperandsKeepWhitespace).

import (
	"reflect"
	"testing"
)

func TestOracle_IssueExample(t *testing.T) {
	if got := Split([]string{"-", "foo", "bar"}).Args; !reflect.DeepEqual(got, []string{"-", "foo", "bar"}) {
		t.Fatalf("Args = %#v", got)
	}
}

func TestOracle_FlagsAfterBareDash(t *testing.T) {
	p := Split([]string{"-", "-v", "foo"})
	if !reflect.DeepEqual(p.Flags, []string{"-v"}) || !reflect.DeepEqual(p.Args, []string{"-", "foo"}) {
		t.Fatalf("%+v", p)
	}
}

func TestOracle_BareDashKeepsSpelling(t *testing.T) {
	if got := Split([]string{" - ", "foo"}).Args; !reflect.DeepEqual(got, []string{" - ", "foo"}) {
		t.Fatalf("Args = %#v", got)
	}
}
