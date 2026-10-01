# Running without egress

If your code cannot leave your network, most of this category is unavailable to
you regardless of what the sales conversation suggests.

## Where the tools actually stand

Verified from vendor documentation, 2026-07-31:

| Tool | Air-gapped |
|---|---|
| Devin | **No.** Single-tenant VPC via AWS PrivateLink, customer-managed KMS, a federal docs tree -- but "Devin's brain... always resides within Cognition's Cloud." |
| Cursor | No. Cloud service; embeddings are uploaded (obfuscated and encrypted). |
| Claude Code | Partly. Runs against Bedrock / Vertex / Foundry in your own cloud, so data residency is yours -- but a model endpoint is still required. |
| Lovable, Replit, Emergent | No. Browser products on their infrastructure. |
| opencode | Structurally yes (MIT, self-hostable) -- but no SOC2, SSO, audit logs, or support. |

Devin's is the strongest enterprise packaging in the category and it still
cannot run disconnected. That is a structural property of a hosted control
plane, not an oversight.

## What we measured

Executed 2026-07-31 with outbound HTTP forced through an unroutable proxy --
not a flag, not an assumption. Every one of these returned a real result with
egress severed:

| Command | Result |
|---|---|
| `loki version` | works |
| `loki doctor --json` | works |
| `loki plan <spec> --json` | works -- full cost and complexity estimate |
| `loki proof list` | works |
| `loki proof verify <id>` | works, and correctly reported `tree_drift: true` |
| `loki heal <repo> --assess --json` | works -- maturity, ranked targets, runtime |

The whole evaluate-before-you-buy path runs disconnected. You can assess a
legacy codebase, estimate what a build would cost, and verify an existing
receipt without a single packet leaving the machine.

`loki proof verify` deserves emphasis: an auditor can re-check a receipt against
the repository offline and get a genuine verdict, including detecting drift.
That is the property competitors' dashboard-bound verification cannot have.

## The one required egress, stated plainly

```sh
loki doctor --airgap
```

`bin/loki` routes the flag straight to the bash audit regardless of route, so
no `LOKI_LEGACY_BASH=1` prefix is required. It prints the egress inventory. On
a default install it reports exactly one REQUIRED point:

```
REQUIRED  model inference -> https://api.anthropic.com
optional  telemetry           [on]  -> https://us.i.posthog.com
optional  update check        [on]  disable: export LOKI_NO_UPDATE_CHECK=1
```

It judges the provider `loki start` would use (the project's saved
`loki provider set` choice, else `LOKI_PROVIDER`), and runs on both the default
route and `LOKI_LEGACY_BASH=1`. `--json` gives the same inventory for scripts.
It covers the egress the engine configures, and names what it does not audit
because it depends on the project: package installs (the app runner's npm, pip
and docker steps for the built app, the dashboard venv from PyPI, and
quality-gate tools fetched by `npx` when not installed locally; mirror or
pre-install them, since a failed `npx` fetch fails that gate) and the delegate
PR (`git push` and `gh pr create` after a successful run when `gh` is
installed; `LOKI_DELEGATE_PR=0` turns it off).

With a non-claude provider selected, `loki start` on the default (bash) route
and `loki quickstart` never prompt the `claude` CLI, even when one is
installed: PRD enrichment, done recognition, the council voters, the USAGE.md
refresh and the quickstart intent check fall back to their deterministic
paths. The opt-in Bun loop (`LOKI_SDK_LOOP=1`) is not yet held to this.
`LOKI_ALLOW_CLAUDE_SIDECALLS=1` restores those claude calls, and the audit then lists them as REQUIRED egress, so it cannot read air-gap ready.

**We cannot run a build with no model at all.** Nobody can. What we can do is
let you point at a model you host. Only a local-weights provider clears the
required line: opencode, cline or aider with an `ollama/` or `lmstudio/` model
id in that provider's own variable (for example
`LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder`). An Ollama cloud model (a `:cloud`
or `-cloud` tag) runs on ollama.com and is still reported as required. The
verdict comes from the model id; the audit does not read where your Ollama or
LM Studio endpoint listens, so confirm that yourself. An in-network gateway for
claude or codex (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) keeps traffic inside
your network, but the audit still counts it as required egress.

Telemetry is ON by default for an individual interactive install and auto-off
in CI, non-interactive, `LOKI_ENTERPRISE=true` and `LOKI_AIRGAP=true`
contexts. The audit shows its real state. Every opt-out wins (`DO_NOT_TRACK=1`,
`LOKI_TELEMETRY=off`, `loki telemetry off`). The adoption instrumentation added
in v8.6.0 requires a second explicit opt-in on top of that -- see
[PRIVACY.md](./PRIVACY.md).

## Why `unknown` is the right answer offline

`loki heal --assess` reports `dependency_staleness: unknown` and always will
without a network call. We know your manifest pins lodash 3.x; we do not know
what is current upstream, and we will not guess.

That refusal is what makes the assessment trustworthy inside a disconnected
network. A tool that fabricates a staleness number offline is more dangerous
than one that declines.

## Honest limits

- **A model endpoint is required.** If you have no model at all -- not local,
  not in-network -- we cannot build anything, and neither can anyone else.
- **The five mutating healing phases need a provider.** Only `--assess` is
  genuinely zero-dependency.
- **Not measured here:** a full disconnected build against a local-weights
  provider. The commands above were measured; that one was not, and this page
  does not claim it.

See [Kubernetes air-gapped install](../deploy/helm/README.md) for the
cluster-side path.
