// Package mathx holds small integer helpers used across the app.
package mathx

// Abs returns the absolute value of v.
func Abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// Clamp limits v to the range [lo, hi].
func Clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
