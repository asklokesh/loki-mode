# hard-2-ledger

Empty starting workspace. The agent writes `ledger.py` from the prompt alone.

The acceptance overlay (`../hard-2-ledger-overlay/check_acceptance.py`) is
copied in only at grading time, so the agent never sees the assertions it must
satisfy. That is the point: the prompt states the REQUIREMENT ("obey the
fundamental accounting rule", "money must not drift") without naming the
technique, so the task measures whether the implementation reasons about the
requirement rather than pattern-matches a spec.
