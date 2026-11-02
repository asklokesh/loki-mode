package config

import "strings"

// EnvPrefix marks the environment variables that override file settings.
const EnvPrefix = "APP_"

// FromEnv turns APP_* variables into config keys: APP_LOG_LEVEL becomes
// log_level. Variables without the prefix are ignored.
func FromEnv(env map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range env {
		if !strings.HasPrefix(k, EnvPrefix) {
			continue
		}
		key := strings.ToLower(strings.TrimPrefix(k, EnvPrefix))
		if key == "" {
			continue
		}
		out[key] = v
	}
	return out
}
