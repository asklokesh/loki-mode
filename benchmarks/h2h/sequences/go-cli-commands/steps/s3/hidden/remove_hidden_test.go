package tests

import (
	"bytes"
	"strings"
	"testing"

	"example.com/notes/cli"
	"example.com/notes/notes"
)

func removeRun(t *testing.T, st *notes.Store, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := cli.Run(args, st, &out)
	return out.String(), err
}

func removeSeed() *notes.Store {
	st := notes.NewStore()
	st.Add("buy milk", []string{"home"})
	st.Add("call bob", nil)
	st.Add("fix sink", nil)
	return st
}

func TestHiddenRemoveDeletesNote(t *testing.T) {
	st := removeSeed()
	out, err := removeRun(t, st, "remove", "2")
	if err != nil || out != "removed 2\n" {
		t.Fatalf("got %q, %v", out, err)
	}
	all := st.All()
	if len(all) != 2 || all[0].ID != 1 || all[1].ID != 3 {
		t.Fatalf("store = %+v", all)
	}
}

func TestHiddenRemoveUnknownOrAlreadyRemoved(t *testing.T) {
	st := removeSeed()
	removeRun(t, st, "remove", "1")
	for _, id := range []string{"1", "9"} {
		out, err := removeRun(t, st, "remove", id)
		if err == nil || err.Error() != "no note with id "+id || out != "" {
			t.Fatalf("remove %s: got %q, %v", id, out, err)
		}
	}
}

func TestHiddenRemoveUsage(t *testing.T) {
	for _, args := range [][]string{{"remove"}, {"remove", "1", "2"}, {"remove", "x"}, {"remove", "0"}, {"remove", "-3"}, {"remove", "+1"}} {
		out, err := removeRun(t, removeSeed(), args...)
		if err == nil || err.Error() != "usage: remove <id>" || out != "" {
			t.Fatalf("%v: got %q, %v", args, out, err)
		}
	}
	if len(removeSeed().All()) != 3 {
		t.Fatal("seed changed")
	}
}

func TestHiddenRemoveKeepsIDsUnique(t *testing.T) {
	st := removeSeed()
	removeRun(t, st, "remove", "3")
	out, err := removeRun(t, st, "add", "new", "one")
	if err != nil || out != "added 4\n" {
		t.Fatalf("got %q, %v", out, err)
	}
}

func TestHiddenHelpListsEveryCommandSorted(t *testing.T) {
	out, err := removeRun(t, notes.NewStore(), "help")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 8 || lines[0] != "usage: notes <command> [args]" || lines[1] != "" || lines[2] != "commands:" {
		t.Fatalf("help output:\n%s", out)
	}
	// the longest usage, "add <text> [#tag ...]", is 21 characters wide
	exact := map[int]string{
		3: "  add <text> [#tag ...]  add a note",
		5: "  help                   show this help",
		7: "  remove <id>            delete a note",
	}
	for i, want := range exact {
		if lines[i] != want {
			t.Fatalf("line %d = %q, want %q", i, lines[i], want)
		}
	}
	if !strings.HasPrefix(lines[4], "  done <id>              ") || !strings.HasPrefix(lines[6], "  list [#tag]            ") {
		t.Fatalf("done/list lines: %q %q", lines[4], lines[6])
	}
	if !strings.HasSuffix(out, "\n") {
		t.Fatal("missing final newline")
	}
}

func TestHiddenHelpTakesNoArguments(t *testing.T) {
	out, err := removeRun(t, notes.NewStore(), "help", "add")
	if err == nil || err.Error() != "usage: help" || out != "" {
		t.Fatalf("got %q, %v", out, err)
	}
}
