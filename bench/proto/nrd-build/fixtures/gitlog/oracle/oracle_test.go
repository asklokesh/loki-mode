package changelog

// Private oracle: scored after the differential runs, never shown to any prompt. It plays the maintainer's hidden test:
// the requested change plus the neighbouring behavior the maintainer expects to stay put.

import (
	"reflect"
	"testing"
)

func TestOracleCommitsKeepMerges(t *testing.T) {
	want := []string{"git", "log", "--pretty=format:%s", "v1.2.0..HEAD"}
	if got := CommitsCmd("v1.2.0", "HEAD"); !reflect.DeepEqual(got, want) {
		t.Fatalf("CommitsCmd = %q", got)
	}
}

func TestOracleAuthorsStillSkipMerges(t *testing.T) {
	want := []string{"git", "log", "--no-merges", "--pretty=format:%an <%ae>", "v1.2.0..HEAD"}
	if got := AuthorsCmd("v1.2.0", "HEAD"); !reflect.DeepEqual(got, want) {
		t.Fatalf("AuthorsCmd = %q", got)
	}
}

func TestOracleRenderKeepsSubjectsVerbatim(t *testing.T) {
	got := Render("v2.0.0", []string{"Merge pull request #41 from team/export", "Fix crash"})
	want := "## v2.0.0\n\n- Merge pull request #41 from team/export\n- Fix crash\n"
	if got != want {
		t.Fatalf("Render = %q", got)
	}
}

func TestOracleContributorsAreCaseSensitive(t *testing.T) {
	got := Contributors([]string{"Bo <Bo@x.io>", "bo <bo@x.io>"})
	want := []string{"Bo <Bo@x.io>", "bo <bo@x.io>"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Contributors = %q", got)
	}
}
