package tests

import (
	"errors"
	"math"
	"testing"
	"time"

	"example.com/ratelimit/ratelimit"
)

func approx(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("%s = %v, want %v", label, got, want)
	}
}

func mustBucket(t *testing.T, capacity, rate float64, c *fakeClock) *ratelimit.Bucket {
	t.Helper()
	b, err := ratelimit.NewBucket(capacity, rate, c.Now)
	if err != nil {
		t.Fatalf("NewBucket(%v, %v) error: %v", capacity, rate, err)
	}
	if b == nil {
		t.Fatal("NewBucket returned a nil bucket")
	}
	return b
}

func TestHiddenBucketStartsFull(t *testing.T) {
	c := newClock()
	b := mustBucket(t, 5, 1, c)
	approx(t, "Tokens()", b.Tokens(), 5)
}

func TestHiddenBucketConsumes(t *testing.T) {
	c := newClock()
	b := mustBucket(t, 5, 1, c)
	if !b.Allow(2) {
		t.Fatal("Allow(2) on a full bucket of 5 should succeed")
	}
	approx(t, "Tokens()", b.Tokens(), 3)
	if !b.Allow(3) {
		t.Fatal("Allow(3) with 3 tokens left should succeed")
	}
	approx(t, "Tokens()", b.Tokens(), 0)
	if b.Allow(1) {
		t.Fatal("Allow(1) on an empty bucket should fail")
	}
}

func TestHiddenBucketFailedAllowTakesNothing(t *testing.T) {
	c := newClock()
	b := mustBucket(t, 4, 1, c)
	if !b.Allow(3) {
		t.Fatal("Allow(3) should succeed")
	}
	if b.Allow(2) {
		t.Fatal("Allow(2) with 1 token left should fail")
	}
	approx(t, "Tokens() after a refused Allow", b.Tokens(), 1)
	if !b.Allow(1) {
		t.Fatal("Allow(1) with 1 token left should succeed")
	}
}

func TestHiddenBucketFractionalRefill(t *testing.T) {
	c := newClock()
	b := mustBucket(t, 10, 2, c)
	if !b.Allow(10) {
		t.Fatal("Allow(10) on a full bucket of 10 should succeed")
	}
	c.Advance(250 * time.Millisecond)
	approx(t, "Tokens() after 250ms at 2/s", b.Tokens(), 0.5)
	if b.Allow(1) {
		t.Fatal("Allow(1) with 0.5 tokens should fail")
	}
	c.Advance(250 * time.Millisecond)
	approx(t, "Tokens() after 500ms at 2/s", b.Tokens(), 1)
	if !b.Allow(0.75) {
		t.Fatal("Allow(0.75) with 1 token should succeed")
	}
	approx(t, "Tokens()", b.Tokens(), 0.25)
}

func TestHiddenBucketNeverExceedsCapacity(t *testing.T) {
	c := newClock()
	b := mustBucket(t, 3, 5, c)
	c.Advance(time.Hour)
	approx(t, "Tokens() after a long idle", b.Tokens(), 3)
	if !b.Allow(1) {
		t.Fatal("Allow(1) should succeed")
	}
	c.Advance(100 * time.Millisecond)
	approx(t, "Tokens()", b.Tokens(), 2.5)
	c.Advance(10 * time.Second)
	approx(t, "Tokens()", b.Tokens(), 3)
}

func TestHiddenBucketAllowMoreThanCapacity(t *testing.T) {
	c := newClock()
	b := mustBucket(t, 2, 1, c)
	if b.Allow(2.5) {
		t.Fatal("Allow(n > capacity) must always be false")
	}
	approx(t, "Tokens() after Allow(n > capacity)", b.Tokens(), 2)
	c.Advance(time.Hour)
	if b.Allow(3) {
		t.Fatal("Allow(n > capacity) must stay false even after a long wait")
	}
	approx(t, "Tokens()", b.Tokens(), 2)
	if !b.Allow(2) {
		t.Fatal("Allow(capacity) on a full bucket should succeed")
	}
}

func TestHiddenBucketNonPositiveAllow(t *testing.T) {
	c := newClock()
	b := mustBucket(t, 2, 1, c)
	for _, n := range []float64{0, -1, math.NaN()} {
		if b.Allow(n) {
			t.Fatalf("Allow(%v) should be false", n)
		}
	}
	approx(t, "Tokens()", b.Tokens(), 2)
}

func TestHiddenBucketClockBackwards(t *testing.T) {
	c := newClock()
	b := mustBucket(t, 10, 1, c)
	if !b.Allow(10) {
		t.Fatal("Allow(10) should succeed")
	}
	c.Advance(-5 * time.Second)
	approx(t, "Tokens() after the clock went back", b.Tokens(), 0)
	if b.Allow(1) {
		t.Fatal("a clock going backwards must not add tokens")
	}
	c.Advance(6 * time.Second)
	approx(t, "Tokens() 1s past the latest time seen", b.Tokens(), 1)
}

func TestHiddenBucketRejectsBadConfig(t *testing.T) {
	c := newClock()
	cases := []struct {
		capacity, rate float64
		now            func() time.Time
	}{
		{0, 1, c.Now},
		{-1, 1, c.Now},
		{1, 0, c.Now},
		{1, -2, c.Now},
		{math.NaN(), 1, c.Now},
		{1, math.NaN(), c.Now},
		{math.Inf(1), 1, c.Now},
		{1, math.Inf(1), c.Now},
		{1, 1, nil},
	}
	for _, tc := range cases {
		b, err := ratelimit.NewBucket(tc.capacity, tc.rate, tc.now)
		if !errors.Is(err, ratelimit.ErrInvalidConfig) {
			t.Fatalf("NewBucket(%v, %v, nil=%v) err = %v, want ErrInvalidConfig", tc.capacity, tc.rate, tc.now == nil, err)
		}
		if b != nil {
			t.Fatalf("NewBucket(%v, %v) returned a non-nil bucket with an error", tc.capacity, tc.rate)
		}
	}
}
