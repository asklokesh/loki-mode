package ratelimit

import (
	"math"
	"sync"
	"time"
)

// Bucket is a token bucket that refills continuously at a fixed rate.
type Bucket struct {
	mu       sync.Mutex
	capacity float64
	rate     float64
	now      func() time.Time
	tokens   float64
	last     time.Time
}

func positiveFinite(v float64) bool {
	return v > 0 && !math.IsInf(v, 0) && !math.IsNaN(v)
}

// NewBucket returns a full bucket holding capacity tokens that refills at
// refillPerSec tokens per second. It returns ErrInvalidConfig when capacity
// or refillPerSec is not a positive finite number or now is nil.
func NewBucket(capacity float64, refillPerSec float64, now func() time.Time) (*Bucket, error) {
	if !positiveFinite(capacity) || !positiveFinite(refillPerSec) || now == nil {
		return nil, ErrInvalidConfig
	}
	return &Bucket{capacity: capacity, rate: refillPerSec, now: now, tokens: capacity, last: now()}, nil
}

// refill adds the tokens earned since the latest time seen. A clock that went
// backwards adds nothing and leaves the reference time where it was.
func (b *Bucket) refill() {
	t := b.now()
	if !t.After(b.last) {
		return
	}
	b.tokens = math.Min(b.capacity, b.tokens+t.Sub(b.last).Seconds()*b.rate)
	b.last = t
}

// Allow takes n tokens and returns true if they are all available; otherwise
// it takes nothing and returns false.
func (b *Bucket) Allow(n float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	if !(n > 0) || n > b.capacity || n > b.tokens {
		return false
	}
	b.tokens -= n
	return true
}

// Tokens returns the number of tokens available right now.
func (b *Bucket) Tokens() float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	return b.tokens
}
