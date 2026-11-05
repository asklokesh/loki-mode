DurationSetting.Value keeps the spaces around the text

`DurationSetting{Raw: " 5s "}.Value()` returns `" 5s "` with the spaces still on it. We print it in a status line and the padding breaks the column alignment.

Acceptable outputs for `DurationSetting{Raw: " 5s "}`:
- `DurationSetting.Value()` returns the string `"5s"`
- `DurationSetting.Value()` returns the string `"5s"` and a new `DurationSetting.Duration()` method returns the parsed `time.Duration`

`Value()` has to keep returning a string, since callers print it directly.
