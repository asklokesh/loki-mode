// Package changelog builds the git queries the changelog command runs and renders what they return.
package changelog

import (
	"fmt"
	"sort"
	"strings"
)

// logArgs is the git log prefix every history query shares.
func logArgs(format string) []string {
	return []string{"git", "log", "--no-merges", "--pretty=format:" + format}
}

// CommitsCmd lists the commit subjects between two refs.
func CommitsCmd(from, to string) []string {
	return append(logArgs("%s"), from+".."+to)
}

// AuthorsCmd lists the author of every commit between two refs, for the credits section.
func AuthorsCmd(from, to string) []string {
	return append(logArgs("%an <%ae>"), from+".."+to)
}

// LastTagCmd finds the most recent tag reachable from HEAD.
func LastTagCmd() []string {
	return []string{"git", "describe", "--tags", "--abbrev=0"}
}

// Render formats commit subjects as a markdown list under a version heading.
func Render(version string, subjects []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "## %s\n\n", version)
	for _, s := range subjects {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		fmt.Fprintf(&b, "- %s\n", s)
	}
	return b.String()
}

// Contributors turns author lines into a sorted list without duplicates.
func Contributors(lines []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" || seen[l] {
			continue
		}
		seen[l] = true
		out = append(out, l)
	}
	sort.Strings(out)
	return out
}
