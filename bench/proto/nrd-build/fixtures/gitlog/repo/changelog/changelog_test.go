package changelog

import (
	"reflect"
	"strings"
	"testing"
)

func TestCommitsCmdRange(t *testing.T) {
	got := strings.Join(CommitsCmd("v1.0.0", "HEAD"), " ")
	if !strings.HasPrefix(got, "git log") || !strings.HasSuffix(got, "v1.0.0..HEAD") {
		t.Fatalf("CommitsCmd = %q", got)
	}
}

func TestLastTagCmd(t *testing.T) {
	want := []string{"git", "describe", "--tags", "--abbrev=0"}
	if got := LastTagCmd(); !reflect.DeepEqual(got, want) {
		t.Fatalf("LastTagCmd = %v", got)
	}
}

func TestRenderSkipsBlankSubjects(t *testing.T) {
	got := Render("v1.1.0", []string{"Add export", "  ", "Fix crash on empty config"})
	want := "## v1.1.0\n\n- Add export\n- Fix crash on empty config\n"
	if got != want {
		t.Fatalf("Render = %q", got)
	}
}

func TestContributorsDedupes(t *testing.T) {
	got := Contributors([]string{"bo <bo@x.io>", "al <al@x.io>", "bo <bo@x.io>"})
	want := []string{"al <al@x.io>", "bo <bo@x.io>"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Contributors = %v", got)
	}
}
