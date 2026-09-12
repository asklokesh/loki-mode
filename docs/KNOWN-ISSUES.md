
## doctor --json writes 108 bytes to stderr on a provider-less host

`bash autonomy/loki doctor --json` on a host with NO provider CLI emits:

```
autonomy/loki: line 14066: required: command not found
autonomy/loki: line 14066: status: command not found
```

**Not user-affecting, and not a JSON defect.** stdout is 5176 bytes of valid
JSON; only stderr is polluted. Every `doctor --json` assertion in the repo
discards stderr (`tests/test-airgap-commands.sh:50`,
`tests/test-doctor-blocker-parity.sh:129,132`,
`tests/test-doctor-ci-gateable.sh:46,84,86`).
`tests/test-e2e-features.sh:104` was the lone outlier using `2>&1` and has been
brought into line.

**Attribution:** introduced this session. `git show 0416810d:autonomy/loki`
(v9.48.2) emits 0 bytes on the same host; HEAD emits 108. The region was last
touched by `56e03374 feat(doctor): show provider availability`.

**Six hypotheses tested and REFUTED, so the next person does not repeat them:**

1. Word-splitting of `$_provider_availability` at `:14066` -- the assignment is
   correctly quoted; reproduced in isolation as OK.
2. `provider_availability_json` emitting to stderr -- 0 bytes, clean 353-byte
   JSON in isolation.
3. Its callees `auto_detect_provider` / `check_provider_installed` -- both
   silent.
4. The JSON value's content -- `required` and `status` appear 0 times in it.
5. The value being multi-line and breaking the env-assignment chain -- forcing
   `LOKI_PROVIDER_AVAILABILITY=""` as a literal STILL reproduces.
6. `render_provider_availability` -- silent in isolation, and disabling the call
   still reproduces.

**Also known:** `bash -n` parses the file clean; sourcing the file and calling
`cmd_doctor_json` directly emits 0 bytes, while executing the file emits 108.
That difference (streaming read vs single parse) is the strongest remaining
lead. The words `required` and `status` are python identifiers at `:14085-14098`
inside the `python3 -c "` string that opens at `:14069`.

