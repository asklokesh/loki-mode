// Package ratelimit holds the request limiters used by the API gateway.
package ratelimit

import (
	"errors"
	"time"
)

// ErrInvalidConfig is returned by constructors given an unusable configuration.
var ErrInvalidConfig = errors.New("ratelimit: invalid config")

// Window is a fixed-window counter: at most Limit events per window of Size.
type Window struct {
	limit int
	size  time.Duration
	now   func() time.Time
	start time.Time
	count int
}

// NewWindow returns a fixed-window limiter. limit and size must be positive
// and now must not be nil, otherwise it returns ErrInvalidConfig.
func NewWindow(limit int, size time.Duration, now func() time.Time) (*Window, error) {
	if limit <= 0 || size <= 0 || now == nil {
		return nil, ErrInvalidConfig
	}
	return &Window{limit: limit, size: size, now: now, start: now()}, nil
}

// Allow records one event and reports whether it fits in the current window.
func (w *Window) Allow() bool {
	t := w.now()
	if t.Sub(w.start) >= w.size {
		w.start = t
		w.count = 0
	}
	if w.count >= w.limit {
		return false
	}
	w.count++
	return true
}
