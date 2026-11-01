package tests

import (
	"bytes"
	"testing"

	"example.com/notes/cli"
	"example.com/notes/notes"
)

func listRun(t *testing.T, st *notes.Store, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := cli.Run(args, st, &out)
	return out.String(), err
}

func listSeed() *notes.Store {
	st := notes.NewStore()
	st.Add("buy milk", []string{"home", "errand"})
	st.Add("call bob", nil)
	st.Add("fix sink", []string{"home"})
	return st
}

func TestHiddenListAll(t *testing.T) {
	st := listSeed()
	st.SetDone(2, true)
	out, err := listRun(t, st, "list")
	want := "1. [ ] buy milk #home #errand\n2. [x] call bob\n3. [ ] fix sink #home\n"
	if err != nil || out != want {
		t.Fatalf("got %q, %v; want %q", out, err, want)
	}
}

func TestHiddenListByTag(t *testing.T) {
	out, err := listRun(t, listSeed(), "list", "#home")
	want := "1. [ ] buy milk #home #errand\n3. [ ] fix sink #home\n"
	if err != nil || out != want {
		t.Fatalf("got %q, %v; want %q", out, err, want)
	}
	out, err = listRun(t, listSeed(), "list", "#errand")
	if err != nil || out != "1. [ ] buy milk #home #errand\n" {
		t.Fatalf("got %q, %v", out, err)
	}
}

func TestHiddenListEmpty(t *testing.T) {
	out, err := listRun(t, notes.NewStore(), "list")
	if err != nil || out != "no notes\n" {
		t.Fatalf("got %q, %v", out, err)
	}
	out, err = listRun(t, listSeed(), "list", "#work")
	if err != nil || out != "no notes\n" {
		t.Fatalf("got %q, %v", out, err)
	}
}

func TestHiddenListTagMatchIsExact(t *testing.T) {
	out, err := listRun(t, listSeed(), "list", "#hom")
	if err != nil || out != "no notes\n" {
		t.Fatalf("got %q, %v", out, err)
	}
}

func TestHiddenListUsage(t *testing.T) {
	for _, args := range [][]string{{"list", "home"}, {"list", "#home", "#errand"}, {"list", "#"}} {
		out, err := listRun(t, listSeed(), args...)
		if err == nil || err.Error() != "usage: list [#tag]" || out != "" {
			t.Fatalf("%v: got %q, %v", args, out, err)
		}
	}
}

func TestHiddenListAfterAdd(t *testing.T) {
	st := notes.NewStore()
	if _, err := listRun(t, st, "add", "water", "plants", "#home"); err != nil {
		t.Fatal(err)
	}
	out, err := listRun(t, st, "list")
	if err != nil || out != "1. [ ] water plants #home\n" {
		t.Fatalf("got %q, %v", out, err)
	}
}
