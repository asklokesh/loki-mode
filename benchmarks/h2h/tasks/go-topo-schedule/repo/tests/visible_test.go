package tests

import (
	"reflect"
	"testing"

	"example.com/sched/sched"
)

func TestDependents(t *testing.T) {
	got := sched.Dependents(map[string][]string{
		"app":  {"lib", "util", "lib"},
		"lib":  {"util"},
		"util": nil,
	})
	want := map[string][]string{
		"app":  {},
		"lib":  {"app"},
		"util": {"app", "lib"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Dependents = %v, want %v", got, want)
	}
}

func TestDependentsEmpty(t *testing.T) {
	if got := sched.Dependents(nil); len(got) != 0 {
		t.Fatalf("Dependents(nil) = %v", got)
	}
}
