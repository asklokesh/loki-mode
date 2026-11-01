// Package config reads application settings from a key=value file and
// APP_* environment variables and merges them into one Config.
package config

import (
	"fmt"
	"strings"
)

// ParseFile parses key=value lines. Blank lines and lines starting with #
// are skipped; keys are lowercased and keys and values are trimmed. Only the
// first '=' separates key from value, so values may contain '='.
func ParseFile(text string) (map[string]string, error) {
	out := map[string]string{}
	for i, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: missing '='", i+1)
		}
		key := strings.ToLower(strings.TrimSpace(k))
		if key == "" {
			return nil, fmt.Errorf("line %d: empty key", i+1)
		}
		out[key] = strings.TrimSpace(v)
	}
	return out, nil
}
