# Spec: three text and number utilities

Implement three independent units in the `units/` package. Each file currently holds stubs that raise `NotImplementedError`. Implement ALL three; the work is only complete when every unit meets its contract. Standard library only.

## Unit 1: `units/duration.py`

`parse_duration(text) -> int` returns whole seconds.
- Accepts one or more components in order of any units: `<int>d`, `<int>h`, `<int>m`, `<int>s` (for example `1h30m`, `2d`, `45s`, `1d2h3m4s`). `d` is 86400 seconds.
- Surrounding whitespace is ignored. Matching is case-insensitive. Spaces between components are allowed (`1h 30m`).
- Empty text, a component without a unit, an unknown unit, a negative number or any other character raises `ValueError`.
- The same unit may not appear twice (`1h2h` raises `ValueError`).

`format_duration(seconds) -> str` is the inverse for non-negative ints: the largest units first, omitting zero components, separated by no space (`5400` gives `1h30m`, `0` gives `0s`, `90061` gives `1d1h1m1s`). A negative or non-int value raises `ValueError`. `parse_duration(format_duration(n)) == n` must hold.

## Unit 2: `units/money.py`

`format_cents(cents, currency="USD") -> str`.
- `cents` is an int (negative allowed). Output has a symbol prefix, thousands separators and exactly two decimals: `1234567` gives `$12,345.67`, `5` gives `$0.05`.
- Negative amounts put the sign before the symbol: `-250` gives `-$2.50`.
- Currencies: `USD` is `$`, `EUR` is `EUR ` (code then one space), `GBP` is `GBP `. Any other currency raises `ValueError`.
- A non-int `cents` (including bool and float) raises `TypeError`.

`split_cents(total, parts) -> list[int]` splits `total` cents into `parts` shares that sum exactly to `total`. Shares differ by at most 1 cent and the larger shares come first (`split_cents(100, 3)` gives `[34, 33, 33]`). `parts` must be an int >= 1 and `total` an int >= 0, otherwise `ValueError`.

## Unit 3: `units/wrap.py`

`wrap_text(text, width) -> list[str]` greedy word wrap.
- Words are separated by any whitespace; runs of whitespace collapse to one space. Lines contain no leading or trailing space.
- A line never exceeds `width` unless one single word is longer than `width`; such a word is placed alone on its own line, unbroken.
- Empty or all-whitespace text gives `[]`.
- `width` must be an int >= 1, otherwise `ValueError`.
