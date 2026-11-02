package tests

import (
	"bytes"
	"testing"

	"example.com/notes/cli"
	"example.com/notes/notes"
)

func doneRun(t *testing.T, st *notes.Store, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := cli.Run(args, st, &out)
	return out.String(), err
}

func doneSeed() *notes.Store {
	st := notes.NewStore()
	st.Add("buy milk", []string{"home"})
	st.Add("call bob", nil)
	return st
}

func TestHiddenDoneMarksNote(t *testing.T) {
	st := doneSeed()
	out, err := doneRun(t, st, "done", "2")
	if err != nil || out != "done 2\n" {
		t.Fatalf("got %q, %v", out, err)
	}
	if n, _ := st.Get(2); !n.Done {
		t.Fatal("note 2 not done")
	}
	if n, _ := st.Get(1); n.Done {
		t.Fatal("note 1 changed")
	}
}

func TestHiddenDoneTwiceIsFine(t *testing.T) {
	st := doneSeed()
	doneRun(t, st, "done", "1")
	out, err := doneRun(t, st, "done", "1")
	if err != nil || out != "done 1\n" {
		t.Fatalf("got %q, %v", out, err)
	}
}

func TestHiddenDoneUnknownID(t *testing.T) {
	out, err := doneRun(t, doneSeed(), "done", "7")
	if err == nil || err.Error() != "no note with id 7" || out != "" {
		t.Fatalf("got %q, %v", out, err)
	}
}

func TestHiddenDoneUsage(t *testing.T) {
	for _, args := range [][]string{{"done"}, {"done", "1", "2"}, {"done", "abc"}, {"done", "-1"}, {"done", "0"}, {"done", "+1"}, {"done", "1.5"}} {
		out, err := doneRun(t, doneSeed(), args...)
		if err == nil || err.Error() != "usage: done <id>" || out != "" {
			t.Fatalf("%v: got %q, %v", args, out, err)
		}
	}
}
