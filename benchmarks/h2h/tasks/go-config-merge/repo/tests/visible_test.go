package tests

import (
	"testing"
	"time"

	"example.com/appcfg/config"
	"example.com/appcfg/server"
)

func TestDefaultsWhenNothingSet(t *testing.T) {
	s, err := server.Load("", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := server.Settings{Host: "127.0.0.1", Port: 8080, Timeout: 30 * time.Second}
	if s != want {
		t.Fatalf("Settings = %+v, want %+v", s, want)
	}
}

func TestFileValues(t *testing.T) {
	s, err := server.Load("# server\nhost = 0.0.0.0\nPORT=9000\ntimeout=45\ndebug=true\n", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := server.Settings{Host: "0.0.0.0", Port: 9000, Timeout: 45 * time.Second, Debug: true}
	if s != want {
		t.Fatalf("Settings = %+v, want %+v", s, want)
	}
}

func TestEnvOverridesFile(t *testing.T) {
	s, err := server.Load("port=9000\n", map[string]string{"APP_PORT": "7000", "PORT": "1"})
	if err != nil {
		t.Fatal(err)
	}
	if s.Port != 7000 {
		t.Fatalf("Port = %d, want 7000", s.Port)
	}
}

func TestParseFileMissingEquals(t *testing.T) {
	if _, err := config.ParseFile("host=a\njunk\n"); err == nil {
		t.Fatal("expected an error for a line without '='")
	}
}
