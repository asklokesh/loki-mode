// Package mathx holds small integer helpers used across the app.
package mathx

import "errors"

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

// Gcd returns the greatest common divisor of a and b, never negative.
func Gcd(a, b int) int {
	a, b = Abs(a), Abs(b)
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

// Lcm returns the least common multiple of a and b, never negative; 0 when either is 0.
func Lcm(a, b int) int {
	if a == 0 || b == 0 {
		return 0
	}
	return Abs(a/Gcd(a, b)*b)
}

// IsPrime reports whether n is prime.
func IsPrime(n int) bool {
	if n < 2 {
		return false
	}
	for d := 2; d*d <= n; d++ {
		if n%d == 0 {
			return false
		}
	}
	return true
}

// Pow returns base to the power exp; a negative exp is an error.
func Pow(base, exp int) (int, error) {
	if exp < 0 {
		return 0, errors.New("negative exponent")
	}
	r := 1
	for i := 0; i < exp; i++ {
		r *= base
	}
	return r, nil
}
