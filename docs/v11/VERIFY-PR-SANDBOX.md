# VERIFY-PR sandbox: spec, threat model, runner contract (VPR-1)

Runner: `scripts/verify-pr-sandbox.sh`. Test: `tests/test-verify-pr-sandbox.sh`. Consumer: VPR-2 (`loki verify-pr`).

## Rule of Two
The verify job holds untrusted input (the PR code). It holds NO token and has NO network. A separate job that never executes PR code holds `checks: write`, reads only the result file, and posts. This runner is the first job's execution boundary.

## Contract
```
verify-pr-sandbox.sh --repo DIR --out DIR --cmd 'SHELL CMD' --image IMG [--timeout S] [--max-output B] [--print-argv]
```
- Exit 0: the check ran; read `result.json` (`status` COMPLETED, TIMEOUT or ERROR, plus `exit_code`).
- Exit 2: input refused. Exit 3: BLOCKED (docker absent, daemon down, image not local, resource exhaustion). BLOCKED says nothing about the PR and VPR-2 must never map it to a verdict.
- `OUT/result.json` and `OUT/output.txt` are the only files written, both by the host. `output.txt` is the check's captured output, capped at `--max-output` bytes, with the sentinel line removed; treat it as untrusted data. result.json fields: status, exit_code, output_truncated, detail, image, timeout_s.
- The image is never pulled (`--pull never`); dependencies must already be in the image or the caller reports NOT PROVEN.

## Controls
| Control | Mechanism |
|---|---|
| No network | `--network none` |
| Read-only root | `--read-only`; `/work` (exec), `/cap`, `/tmp` are size-capped tmpfs |
| Non-root | `--user 65534:65534`, `--cap-drop ALL`, `no-new-privileges` |
| Caps | `--pids-limit 256`, `--memory 512m` (swap equal), `--cpus 1`, `--init` |
| Wall timeout | in-container `timeout -s KILL`, plus a host watchdog that runs `docker kill <exact name>` (never by pattern) |
| Env scrub | `docker run` inherits no host env; only PATH, HOME=/work, CI=1 are passed. GH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK never reach argv |
| Mounts | exactly one: the repo, read-only. No HOME, no docker socket, no output mount |
| Output | stdout is captured by the host, capped in-container (`--max-output`); the host writes result.json and output.txt |

Deviation from the card: there is no mounted output dir. A writable host mount would let the checked code fill the host disk, so the result travels on stdout and only the host writes `OUT`. Numeric flags are forced to base 10 (a leading zero is not octal) and every value flag requires a value. `--image` is restricted to `[A-Za-z0-9._/:@-]`.

## Threat model
- Malicious package.json scripts / test code: run only inside the container, as nobody, no network.
- Git hooks: the repo is mounted read-only and the runner never runs git; checkout of base/head is VPR-2's job and must use `util/safe_git.ts`.
- Symlinks out of the repo: refused on the host before launch (absolute target, or relative target resolving outside the repo). The copy to `/work` happens inside the container, so a link resolves against the container filesystem only.
- Oversized output: capped by `--max-output`; `output_truncated` is set.
- Fork bomb: `--pids-limit 256`. Memory bomb: `--memory`. Disk fill: tmpfs size caps.
- Forged result: the checked code can print a fake `LOKI_VPR_END` line. A per-run 128-bit nonce is sent to the wrapper on stdin and the checked command runs with stdin from /dev/null; the host accepts only the last line carrying that nonce. Docker's default seccomp profile does NOT block ptrace or process_vm_readv on kernels >= 4.8, and the checked command runs as the same uid as the wrapper inside the container, so a hostile process can read the wrapper's memory and recover the nonce. The nonce therefore only stops accidental or naive forgery; it is not a security boundary. One cross-check is added: the wrapper exits with the check's code and the host rejects (status ERROR) a sentinel that disagrees with docker's own exit code. The PR code can still make its own check report success, which is why `result.json` is a signal about the check and not the final verdict (VPR-2 owns that, and it must not treat a bare COMPLETED exit 0 as proof). A custom seccomp profile denying ptrace is a possible hardening and is not shipped here.
- Docker pool exhaustion: reported as BLOCKED, never as a failing check.

## Not covered (residual, tracked for VPR-2 review)
Kernel or runtime escapes (use gVisor or a microVM runtime for a hosted deployment); Docker Desktop shares the VM across containers; the hostile-container part of the test needs a daemon and a local image and SKIPs loudly otherwise.
