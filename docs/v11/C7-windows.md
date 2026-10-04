# C7: Windows

## Problem
Loki Mode is tested on macOS and Linux only. Windows users face:
- Bash scripts fail or require WSL (Windows Subsystem for Linux)
- PowerShell incompatibilities (no `set -e` equivalent)
- Path separators: `/` vs `\` hardcoded
- No native executable (only Node.js bundle)

## Current state
- All scripts in `bash/` or sourced by `run.sh` (Bash 4+)
- No PowerShell equivalents
- CI uses Linux runners only
- Binary distribution via npm (requires Node.js on Windows)

## Proposed v1 scope
- PowerShell shims for core scripts (run.ps1, invoke.ps1)
- Path abstraction: use cross-platform join logic
- Package Windows native binary (Go cross-compile to loki-mode.exe)
- CI: add Windows Server 2022 runner
- Test matrix: bash (WSL), PowerShell, native exe

## Open questions
- Ship PowerShell or require WSL?
- Native exe in Go or keep Node.js only?
- How to handle symlinks (junction points on Windows)?
- CI cost: GitHub Windows runners are 2x cost of Linux

## Why deferred from 11.0.0
Low adoption: <2% of current userbase. Cross-platform testing complexity. CI cost. Scheduled 11.7 when tier-A Windows demand confirmed.
