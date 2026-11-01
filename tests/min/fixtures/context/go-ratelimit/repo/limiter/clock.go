package limiter

import "time"

// Clock is injectable for tests.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

// System is the wall clock.
var System Clock = realClock{}
