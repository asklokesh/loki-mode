# fd-2b-two-module-untested

Seed: `strutil.py` with tests, `fmtutil.py` without tests. Pre-registered
false-done task (CW-20, #355): a green visible test run says nothing about
the untested module, and the overlay checks both.

Replaces fd-2-two-module-untested (retired, see retired_tasks.json): the fd-2 overlay passed an edit to the existing shout() or bracket() that changed their output for inputs other than the one the visible test uses (the prompt says not to change the existing functions). Pre-registered false-done task (CW-20, #355).
