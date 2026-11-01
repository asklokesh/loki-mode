package tests

import (
	"errors"
	"testing"
	"time"

	"example.com/ratelimit/ratelimit"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) Now() time.Time          { return c.t }
func (c *fakeClock) Advance(d time.Duration) { c.t = c.t.Add(d) }

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
}

func TestWindowLimitsWithinWindow(t *testing.T) {
	c := newClock()
	w, err := ratelimit.NewWindow(2, time.Second, c.Now)
	if err != nil {
		t.Fatal(err)
	}
	if !w.Allow() || !w.Allow() {
		t.Fatal("first two events should be allowed")
	}
	if w.Allow() {
		t.Fatal("third event in the same window should be refused")
	}
	c.Advance(time.Second)
	if !w.Allow() {
		t.Fatal("a new window should allow again")
	}
}

func TestWindowRejectsBadConfig(t *testing.T) {
	c := newClock()
	if _, err := ratelimit.NewWindow(0, time.Second, c.Now); !errors.Is(err, ratelimit.ErrInvalidConfig) {
		t.Fatalf("err = %v, want ErrInvalidConfig", err)
	}
	if _, err := ratelimit.NewWindow(1, time.Second, nil); !errors.Is(err, ratelimit.ErrInvalidConfig) {
		t.Fatalf("err = %v, want ErrInvalidConfig", err)
	}
}
