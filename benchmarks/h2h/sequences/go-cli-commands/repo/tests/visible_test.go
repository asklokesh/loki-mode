package tests

import (
	"bytes"
	"reflect"
	"testing"

	"example.com/notes/cli"
	"example.com/notes/notes"
)

func runCLI(st *notes.Store, args ...string) (string, error) {
	var out bytes.Buffer
	err := cli.Run(args, st, &out)
	return out.String(), err
}

func TestAddStoresTextAndTags(t *testing.T) {
	st := notes.NewStore()
	out, err := runCLI(st, "add", "buy", "milk", "#home", "#errand")
	if err != nil || out != "added 1\n" {
		t.Fatalf("got %q, %v", out, err)
	}
	all := st.All()
	want := []notes.Note{{ID: 1, Text: "buy milk", Tags: []string{"home", "errand"}}}
	if !reflect.DeepEqual(all, want) {
		t.Fatalf("store = %+v", all)
	}
}

func TestAddNeedsText(t *testing.T) {
	_, err := runCLI(notes.NewStore(), "add", "#home")
	if err == nil || err.Error() != "usage: add <text> [#tag ...]" {
		t.Fatalf("err = %v", err)
	}
}

func TestRunErrors(t *testing.T) {
	st := notes.NewStore()
	if _, err := runCLI(st); err == nil || err.Error() != "usage: notes <command> [args]" {
		t.Fatalf("no args err = %v", err)
	}
	if _, err := runCLI(st, "frobnicate"); err == nil || err.Error() != `unknown command "frobnicate"` {
		t.Fatalf("unknown err = %v", err)
	}
}

func TestStoreDoneAndRemove(t *testing.T) {
	st := notes.NewStore()
	st.Add("a", nil)
	st.Add("b", nil)
	if !st.SetDone(2, true) || st.SetDone(9, true) {
		t.Fatal("SetDone")
	}
	if !st.Remove(1) || st.Remove(1) {
		t.Fatal("Remove")
	}
	if n, ok := st.Get(2); !ok || !n.Done {
		t.Fatalf("Get(2) = %+v %v", n, ok)
	}
}
