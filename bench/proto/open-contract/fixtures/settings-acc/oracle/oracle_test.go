package settings

import "testing"

// The issue's acceptable outputs: Value stays a string and is trimmed.
func TestOracle(t *testing.T) {
	var v any = (DurationSetting{Raw: " 5s "}).Value()
	if s, ok := v.(string); !ok || s != "5s" {
		t.Fatalf("Value() = %#v, want the string \"5s\"", v)
	}
}
