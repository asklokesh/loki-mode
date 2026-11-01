// Package server builds the HTTP server's settings from configuration.
package server

import (
	"time"

	"example.com/appcfg/config"
)

// Settings is everything the server needs to start.
type Settings struct {
	Host    string
	Port    int
	Timeout time.Duration
	DSN     string
	Debug   bool
}

// Defaults used when neither the file nor the environment sets a value.
const (
	DefaultHost    = "127.0.0.1"
	DefaultPort    = 8080
	DefaultTimeout = 30 * time.Second
)

// Load reads the config file text and the environment and returns Settings.
func Load(fileText string, env map[string]string) (Settings, error) {
	cfg, err := config.Load(fileText, env)
	if err != nil {
		return Settings{}, err
	}
	return Settings{
		Host:    cfg.String("host", DefaultHost),
		Port:    cfg.Int("port", DefaultPort),
		Timeout: cfg.Duration("timeout", DefaultTimeout),
		DSN:     cfg.String("dsn", ""),
		Debug:   cfg.Bool("debug", false),
	}, nil
}
