# C2: Hosted or remote runner

## Problem
Loki Mode runs only on the user's local machine. Enterprises need:
- Isolated, ephemeral build environments (security, no credential leakage)
- Horizontal scaling: queue runs for execution on a farm of workers
- Audit trail of which machine ran which task

## Current state
- `autonomy/run.sh` executes locally only
- No runner registration or dispatch mechanism
- No queue table in database
- mcp/server.py has no worker heartbeat or job assignment API

## Proposed v1 scope
- Worker registration API: `POST /workers/register` with hostname, CPU, disk, status
- Job queue table with status (pending, claimed, running, done, failed)
- Job assignment: simple round-robin to available workers
- CLI flag `--runner-pool=prod` to dispatch instead of run locally
- Worker heartbeat every 30s with status update
- Audit field in job: which runner IP, user, invocation time

## Open questions
- Deploy runners on Kubernetes or VMs?
- How to provision ephemeral runner images? (Docker, Nix, Terraform?)
- Session affinity: can one user's job see another's?
- Secret injection: per-runner vault, or shared secret store?

## Why deferred from 11.0.0
Infra dependency: requires managed runner service outside repo scope. Licensing cost unclear. No tier-A demand. Scheduled 11.2 when deployment strategy confirmed.
