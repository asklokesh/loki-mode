package settings

import (
	"reflect"
	"testing"
)

func TestIntSettingValue(t *testing.T) {
	if got := (IntSetting{Raw: " 42 "}).Value(); got != 42 {
		t.Fatalf("got %v", got)
	}
}

func TestBoolSettingValue(t *testing.T) {
	if got := (BoolSetting{Raw: "true"}).Value(); got != true {
		t.Fatalf("got %v", got)
	}
}

func TestListSettingValue(t *testing.T) {
	if got := (ListSetting{Raw: "a, b,,c"}).Value(); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("got %v", got)
	}
}

func TestDurationSettingValue(t *testing.T) {
	if got := (DurationSetting{Raw: "5s"}).Value(); got != "5s" {
		t.Fatalf("got %v", got)
	}
}
