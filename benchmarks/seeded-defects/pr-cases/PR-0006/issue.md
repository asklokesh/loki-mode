# PR-0006 linked issue

`read_name(base, name)` must return the path of a file inside base and refuse a name that escapes base.

Clause 1: names such as ../secret raise ValueError.
