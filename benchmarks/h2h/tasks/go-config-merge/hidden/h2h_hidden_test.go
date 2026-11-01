package tests

import (
	"reflect"
	"testing"
	"time"

	"example.com/appcfg/config"
	"example.com/appcfg/server"
)

func mustLoad(t *testing.T, file string, env map[string]string) server.Settings {
	t.Helper()
	s, err := server.Load(file, env)
	if err != nil {
		t.Fatalf("server.Load: %v", err)
	}
	return s
}

func TestHiddenServerTimeoutFromFile(t *testing.T) {
	s := mustLoad(t, "timeout = 1m30s\n", nil)
	if s.Timeout != 90*time.Second {
		t.Fatalf("Timeout = %v, want 1m30s", s.Timeout)
	}
}

func TestHiddenServerTimeoutForms(t *testing.T) {
	cases := map[string]time.Duration{
		"45":      45 * time.Second,
		"250ms":   250 * time.Millisecond,
		"2h":      2 * time.Hour,
		"1h2m3s":  time.Hour + 2*time.Minute + 3*time.Second,
		"0":       0,
		"soon":    server.DefaultTimeout,
		"1m30":    server.DefaultTimeout,
		"1.5s":    1500 * time.Millisecond,
		"10 days": server.DefaultTimeout,
	}
	for v, want := range cases {
		s := mustLoad(t, "timeout="+v+"\n", nil)
		if s.Timeout != want {
			t.Fatalf("timeout=%q gives %v, want %v", v, s.Timeout, want)
		}
	}
}

func TestHiddenServerTimeoutFromEnv(t *testing.T) {
	s := mustLoad(t, "timeout=10\n", map[string]string{"APP_TIMEOUT": "2m"})
	if s.Timeout != 2*time.Minute {
		t.Fatalf("Timeout = %v, want 2m", s.Timeout)
	}
}

func TestHiddenEmptyEnvDoesNotWipeFile(t *testing.T) {
	s := mustLoad(t, "port=9000\nhost=db.local\n", map[string]string{"APP_PORT": "", "APP_HOST": ""})
	if s.Port != 9000 {
		t.Fatalf("Port = %d, want 9000 from the file", s.Port)
	}
	if s.Host != "db.local" {
		t.Fatalf("Host = %q, want db.local from the file", s.Host)
	}
}

func TestHiddenEmptyEnvFallsBackToDefault(t *testing.T) {
	s := mustLoad(t, "", map[string]string{"APP_HOST": "", "APP_PORT": ""})
	if s.Host != server.DefaultHost || s.Port != server.DefaultPort {
		t.Fatalf("Settings = %+v, want defaults", s)
	}
}

func TestHiddenFromEnvIgnoresEmptyValues(t *testing.T) {
	got := config.FromEnv(map[string]string{
		"APP_PORT":      "",
		"APP_LOG_LEVEL": "debug",
		"HOME":          "/root",
	})
	want := map[string]string{"log_level": "debug"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FromEnv = %v, want %v", got, want)
	}
}

func TestHiddenValueContainingEquals(t *testing.T) {
	s := mustLoad(t, "dsn = postgres://db/app?sslmode=disable&x=1\n", nil)
	if s.DSN != "postgres://db/app?sslmode=disable&x=1" {
		t.Fatalf("DSN = %q", s.DSN)
	}
	got, err := config.ParseFile("a = b=c\nempty=\n")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"a": "b=c", "empty": ""}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseFile = %v, want %v", got, want)
	}
}

func TestHiddenPrecedence(t *testing.T) {
	file := "host=file-host\nport=9000\ntimeout=1m\ndebug=false\n"
	env := map[string]string{"APP_PORT": "7000", "APP_DEBUG": "true"}
	s := mustLoad(t, file, env)
	want := server.Settings{Host: "file-host", Port: 7000, Timeout: time.Minute, Debug: true}
	if s != want {
		t.Fatalf("Settings = %+v, want %+v", s, want)
	}
}

func TestHiddenFullScenario(t *testing.T) {
	file := "# prod\nhost = 0.0.0.0\nport = 9000\ntimeout = 1m30s\ndsn = user=app password=s3cret host=db\n"
	env := map[string]string{"APP_PORT": "", "APP_TIMEOUT": "", "APP_DEBUG": "1"}
	s := mustLoad(t, file, env)
	want := server.Settings{
		Host:    "0.0.0.0",
		Port:    9000,
		Timeout: 90 * time.Second,
		DSN:     "user=app password=s3cret host=db",
		Debug:   true,
	}
	if s != want {
		t.Fatalf("Settings = %+v, want %+v", s, want)
	}
}
