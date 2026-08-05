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

prints the egress inventory. Today it reports exactly one REQUIRED point:

```
REQUIRED  model inference -> https://api.anthropic.com
          Set ANTHROPIC_BASE_URL to an in-network gateway, or switch to a
          local-weights provider.
optional  telemetry  [off]  disable: loki telemetry off (default off)
```

**We cannot run a build with no model at all.** Nobody can. What we can do is
let you point at a model you host: set `ANTHROPIC_BASE_URL` to an in-network
gateway, or run a provider with local weights. The engine abstracts over CLIs
rather than over one vendor's API.

Telemetry is off by default and every opt-out wins (`DO_NOT_TRACK=1`,
`LOKI_TELEMETRY=off`, `~/.loki/config`). The adoption instrumentation added in
v8.6.0 requires a second explicit opt-in on top of that -- see
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
