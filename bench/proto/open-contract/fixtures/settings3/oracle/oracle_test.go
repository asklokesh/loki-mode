package settings

import (
	"testing"
	"time"
)

// The maintainer's merged choice in this fixture: Value itself returns the parsed duration (sibling convention).
func TestOracle(t *testing.T) {
	var v any = (DurationSetting{Raw: "5s"}).Value()
	if d, ok := v.(time.Duration); !ok || d != 5*time.Second {
		t.Fatalf("Value() = %#v, want 5s as time.Duration", v)
	}
	if d := (DurationSetting{Raw: "soon"}).Value(); any(d) != any(time.Duration(0)) {
		t.Fatalf("bad input: %#v", d)
	}
}
