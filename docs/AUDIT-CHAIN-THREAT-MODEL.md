# What the audit hash chain does and does not prove

Loki's wedge is a receipt the buyer verifies without trusting us. That claim is
only worth making if we are precise about what the current chain actually
proves. This document states the limit, with a reproduction, because a
tamper-evidence claim that does not hold is worse than no claim: a buyer may
rely on it.

## Measured: the chain is re-forgeable

`src/audit/log.js` computes each entry hash as an unkeyed SHA-256 over public
fields, with a constant genesis:

- genesis is the literal string `GENESIS` (`src/audit/log.js:16`)
- `_computeHash` (`:127-134`) hashes `{seq,timestamp,who,what,where,why,metadata,previousHash}`
- every input to that hash is present in the file the attacker is editing

Nothing in the recipe is secret, so anyone who can write the log can recompute a
complete, internally consistent chain over invented history. Reproduced on
v9.28.1:

```
honest verify   : {"valid":true,"entries":2,"brokenAt":null,"error":null}
forged verify   : {"valid":true,"entries":2,"brokenAt":null,"error":null}
forged contents : NEVER HAPPENED | ALSO FORGED
```

The history was replaced wholesale and `verifyChain()` reported `valid: true`.

### The same holds for the dashboard chain

`dashboard/audit.py` is a separate implementation with the same property:
genesis is the constant `"0" * 64` (`:58`, `:115`), and `_compute_chain_hash`
(`:194-200`) is an unkeyed `sha256(prev_hash + entry_json)`. Its own docstring
at `:197` overstates what the chain proves. Forged with the writer's exact recipe
(`json.dumps(entry, sort_keys=True, default=str)`, field `_integrity_hash`,
`:369-371`), `verify_log_integrity` reports:

```
forged verdict: {'valid': True, 'entries_checked': 2, 'first_tampered_line': None, ...}
contents      : NEVER HAPPENED | ALSO FORGED
```

One methodological note, because it nearly produced a false all-clear here: a
first forgery attempt using a guessed field name returned `valid: False` with
`entries_checked: 0`. That was the verifier rejecting the probe's SCHEMA, not
detecting tampering. A failed exploit can mean the probe was wrong rather than
the target is sound, and `entries_checked: 0` is the tell. Any future test of
this property must assert that entries were actually checked.

## What this means

The chain detects **accidental corruption and truncation**: a partial write, a
dropped line, a byte flip. Those are real failure modes and catching them has
value.

It does **not** detect a deliberate rewrite by anyone with write access to the
log, which is the threat an audit trail exists to address. Under the standard
audit-log threat model the writer is the adversary, and an unkeyed chain the
writer can recompute offers that adversary no obstacle.

Note the failure direction. A broken chain is strong evidence of a problem. An
intact chain is NOT evidence of integrity, because it is exactly what both an
honest run and a competent forgery produce. Absence of evidence is not evidence
of absence.

## What would actually close it

Tamper-evidence requires something the log's writer cannot reproduce. In
increasing order of strength:

1. **A keyed MAC** with a key the agent cannot read. Moves the problem to key
   custody; on a developer laptop where the agent runs as the user, there is
   often nowhere to put such a key that the agent cannot reach.
2. **An external witness**: periodically pin the chain tip somewhere append-only
   that the agent cannot rewrite. `writeWitness` already exists at
   `src/audit/crosslink.js:234` and has zero production callers.
3. **A signature over the tip** with a key held off the machine.

Only 2 and 3 survive an adversary who controls the machine, which is the case
that matters for a receipt a third party is meant to trust.

## What is closed as of v9.30.0

`writeWitness` is now wired and, more importantly, **reconciled**. The gap was
not only that nothing called it: `verifyUnified` called `verifyWitnessFile`,
which checks the witness file's own monotonicity and never compares a witnessed
tip to the live chain. Measured before the fix, with a witness file present and
valid:

```
witnessed tip : 337d47ce70...      live tip now : d376cdd97d...
verifyUnified : {"valid":true, "witness":{"present":true,"valid":true}}
```

A witness nobody reconciles is not a control. `reconcileWitnessedPrefix`
(`src/audit/crosslink.js`) now compares each witnessed tip against the chain
entry at that position, and `verifyUnified` folds the result into its verdict.
The same forgery now returns `valid:false` with the entry named.

The comparison is prefix-based rather than tip-equality on purpose: a chain
legitimately grows after a witness, so requiring the tips to match would fire on
normal operation, and a guard that fires on normal operation gets turned off.
Both directions are mutation-tested.

The subscriber writes a witness at session end and every
`LOKI_AUDIT_WITNESS_INTERVAL_SEC` (default 300; `LOKI_AUDIT_WITNESS=0` opts out).
Periodic witnessing matters because a witness taken only at shutdown is lost to
SIGKILL, which is when the trail matters most.

**What is still open, precisely.** A local witness file is itself rewritable by
the same adversary. What the reconciliation buys is that forging now requires
rewriting the chain AND every witness consistently, rather than the chain alone.
That is a higher bar, not a closed door. The closed door is
`LOKI_AUDIT_WITNESS_COMMAND`, which ships the witness line off the machine to a
WORM mount or timestamping authority: an out-of-band copy is the only form that
survives an adversary who controls this host. It is off by default because it
needs infrastructure we cannot assume.

Two honest limits that remain:

- The subscriber is gated on `LOKI_AUDIT_ENABLED` (default false), so a default
  install still writes no agent chain and no witness.
- Nothing yet witnesses on the Bun route.

## Current honest claim

Until a witness or off-machine signature is wired, the supportable claim is:

> The audit log is hash-chained, which detects corruption and truncation. It is
> not tamper-proof against an adversary with write access to the log.

Do not describe the current chain as tamper-proof, tamper-resistant, or as
evidence a third party can rely on for integrity against a motivated writer.
