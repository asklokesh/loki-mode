DurationSetting.Value returns a string instead of a time.Duration

`DurationSetting.Value()` hands back the raw text, so I end up calling `time.ParseDuration` myself everywhere:

    d, _ := time.ParseDuration(cfg.Timeout.Value())

Should DurationSetting.Value return the parsed time.Duration, or should Value keep returning the string and a new Duration() method return the parsed time.Duration? I want to avoid changing DurationSetting.Value's existing behaviour if possible, since some callers may print it.

A value that does not parse should give 0.

Maintainer reply: I'm not opinionated on which one is better, happy to take a PR either way.
