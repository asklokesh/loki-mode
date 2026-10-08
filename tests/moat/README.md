# Moat suite

Each `p*.sh` property script prints one `CASE <name> PASS|FAIL` line per case and exits 0 whenever it ran to completion. A `p*.sh` exit code is not a verdict. A non-zero exit means the script itself crashed, which `run.sh` reports as a CRASH.

The verdict is `bash tests/moat/run.sh`: its exit code, together with `pending.txt` (known FAILs), `cases.txt` and the ratchets. It exits 1 on any FAIL that is not listed in `pending.txt`.

To check one property directly, run its script and read the CASE lines. Do not use the script's exit code.
