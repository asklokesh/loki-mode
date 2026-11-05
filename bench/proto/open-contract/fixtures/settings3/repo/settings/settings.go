// Package settings reads typed settings from raw strings in a config file.
package settings

import (
	"strconv"
	"strings"
	"time"
)

// IntSetting is a whole-number setting.
type IntSetting struct{ Raw string }

// Value returns the parsed number, or 0 when Raw is not a number.
func (s IntSetting) Value() int {
	n, err := strconv.Atoi(strings.TrimSpace(s.Raw))
	if err != nil {
		return 0
	}
	return n
}

// BoolSetting is an on/off setting.
type BoolSetting struct{ Raw string }

// Value returns the parsed flag, or false when Raw is not a boolean.
func (s BoolSetting) Value() bool {
	b, err := strconv.ParseBool(strings.TrimSpace(s.Raw))
	if err != nil {
		return false
	}
	return b
}

// ListSetting is a comma-separated list setting.
type ListSetting struct{ Raw string }

// Value returns the trimmed, non-empty items.
func (s ListSetting) Value() []string {
	var out []string
	for _, p := range strings.Split(s.Raw, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// DurationSetting is a time span such as "5s" or "2m".
type DurationSetting struct{ Raw string }

// Value returns the setting as written.
func (s DurationSetting) Value() string {
	return s.Raw
}

// Timeout is how long a request may take.
var Timeout = time.Second
