package limiter

import "time"

// Limiter is a token bucket.
type Limiter struct {
	rate   float64 // tokens per second
	burst  float64
	tokens float64
	last   time.Time
	clock  Clock
}

// New returns a full bucket.
func New(rate, burst float64, clock Clock) *Limiter {
	return &Limiter{rate: rate, burst: burst, tokens: burst, last: clock.Now(), clock: clock}
}

func (l *Limiter) refill() {
	now := l.clock.Now()
	if now.Sub(l.last) >= time.Second {
		l.tokens = l.burst
		l.last = now
	}
}

// Allow takes one token when available.
func (l *Limiter) Allow() bool {
	l.refill()
	if l.tokens >= 1 {
		l.tokens--
		return true
	}
	return false
}
