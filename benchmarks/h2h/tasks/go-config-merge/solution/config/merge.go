package config

import (
	"strconv"
	"time"
)

// Config is the merged view of every layer.
type Config struct {
	values map[string]string
}

// Merge combines layers; a key in a later layer overrides earlier ones.
func Merge(layers ...map[string]string) Config {
	values := map[string]string{}
	for _, layer := range layers {
		for k, v := range layer {
			values[k] = v
		}
	}
	return Config{values: values}
}

// Load parses the file text and applies environment overrides on top of it.
func Load(fileText string, env map[string]string) (Config, error) {
	file, err := ParseFile(fileText)
	if err != nil {
		return Config{}, err
	}
	return Merge(file, FromEnv(env)), nil
}

// Lookup returns the raw value of key and whether it is set.
func (c Config) Lookup(key string) (string, bool) {
	v, ok := c.values[key]
	return v, ok
}

// String returns the value of key, or def when the key is not set.
func (c Config) String(key, def string) string {
	if v, ok := c.values[key]; ok {
		return v
	}
	return def
}

// Int returns the value of key as an int, or def when it is not set or is
// not a valid integer.
func (c Config) Int(key string, def int) int {
	v, ok := c.values[key]
	if !ok {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// Bool returns the value of key as a bool (strconv.ParseBool), or def when it
// is not set or not a valid bool.
func (c Config) Bool(key string, def bool) bool {
	v, ok := c.values[key]
	if !ok {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

// Duration returns the value of key as a duration, or def when it is not set
// or cannot be parsed. A plain integer means seconds; anything else is parsed
// with time.ParseDuration ("1m30s", "250ms").
func (c Config) Duration(key string, def time.Duration) time.Duration {
	v, ok := c.values[key]
	if !ok {
		return def
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(secs) * time.Second
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
