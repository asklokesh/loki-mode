package changelog

import (
	"strings"
	"testing"
	"time"
)

func TestLokiProbe(t *testing.T) {
	lokiProbe("p1", "CommitsCmd from v1.2.0 to HEAD", func() any { return strings.Join(CommitsCmd("v1.2.0", "HEAD"), " ") })
	lokiProbe("p2", "CommitsCmd between two tags", func() any { return CommitsCmd("v1.0.0", "v1.1.0") })
	lokiProbe("k1", "AuthorsCmd from v1.2.0 to HEAD", func() any { return AuthorsCmd("v1.2.0", "HEAD") })
	lokiProbe("k2", "LastTagCmd", func() any { return LastTagCmd() })
	lokiProbe("k3", "Render with a merge subject and a blank one", func() any {
		return Render("v2.0.0", []string{"Merge pull request #41 from team/export", " ", "Fix crash"})
	})
	lokiProbe("k4", "Contributors with names that differ only in case", func() any {
		return Contributors([]string{"Bo <Bo@x.io>", "bo <bo@x.io>", "al <al@x.io>"})
	})
	lokiProbe("k5", "Render with no subjects", func() any { return Render("v0.1.0", nil) })
	lokiProbe("k6", "the shared log prefix for the subject format", func() any { return logArgs("%s") })
	lokiProbe("k7", "a helper that does not exist (dropped at base)", func() any { return undefinedHelper() })
	lokiProbe("k8", "the current time (never stable)", func() any { return time.Now().UnixNano() })
}
