package settings

import (
	"testing"
)

func TestIntSettingValue(t *testing.T) {
	if got := (IntSetting{Raw: " 42 "}).Value(); got != 42 {
		t.Fatalf("got %v", got)
	}
}

func TestBoolSettingValue(t *testing.T) {
	if got := (BoolSetting{Raw: "true"}).Value(); got != "true" {
		t.Fatalf("got %v", got)
	}
	if !(BoolSetting{Raw: "true"}).Enabled() {
		t.Fatal("Enabled")
	}
}

func TestDurationSettingValue(t *testing.T) {
	if got := (DurationSetting{Raw: "5s"}).Value(); got != "5s" {
		t.Fatalf("got %v", got)
	}
}
