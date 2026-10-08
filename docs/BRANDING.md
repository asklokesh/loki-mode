# Branding: Loki (the agent) by Autonomi (the company)

Authoritative naming reference. Founder directive 2026-06-12. Consult this
before naming any product, doc heading, marketing surface, CLI string, or
release note. When in doubt, this file wins.

## The one rule

**Loki Mode is the agent / brand ambassador. Autonomi is the company and the
name on everything commercial.**

**CRITICAL: this is a BRANDING distinction only. Nothing technical changes
between free and paid.** The same software, CLI, SDK, MCP server, agent, and
code ship to free OSS users and to paid/enterprise/cloud users. Loki is the CLI,
the SDK, the MCP server, the agent - for everyone. The ONLY difference is the
brand label on the *offering*: an OSS/free user runs "Loki Mode"; a paying
team/enterprise buys the same thing under the "Autonomi" brand (Autonomi Cloud,
Autonomi Enterprise). There is no separate "enterprise build" or "cloud fork" of
the engine - it is one product, two brand labels chosen by audience. Do NOT
rename, fork, gate, or technically diverge anything; only relabel the commercial
*presentation*.

The relationship is the industry pattern of "named assistant, by company":
- Alexa by Amazon
- Copilot by GitHub
- Watson by IBM
- Gemini by Google
- Ellie by Entelligence
- **Loki by Autonomi**

Loki is *who you talk to and what you run*. Autonomi is *who you pay and who
stands behind the enterprise/cloud product*. The chat box on autonomi.dev is
"chat with Loki." The invoice says Autonomi.

## What is called "Loki Mode" (the agent / free / OSS)

Everything free, source-available, OSS, and developer-facing keeps the **Loki**
name:
- The CLI: `loki` (binary), "Loki Mode" (product name of the OSS tool).
- The SDK(s): "Loki SDK".
- The local dashboard / web app (runs on the user's machine): "Loki Mode dashboard".
- The agent persona / chat: "Loki" (the thing users converse with, everywhere -
  including inside Autonomi Cloud and on autonomi.dev).
- The npm package `loki-mode`, the Docker image `asklokesh/loki-mode`, the
  Homebrew formula, the MCP server `io.github.asklokesh/loki-mode` - all KEEP
  their identifiers (renaming published artifact IDs breaks installs; do NOT
  rename them).
- The benchmarks, the RARV/council engine, the memory system - the *technology*
  is Loki.

## What is called "Autonomi" (the company / commercial / paid)

Everything commercial, hosted, paid, or enterprise wears the **Autonomi** brand:
- **Autonomi** - the company (autonomi.dev).
- **Autonomi Cloud** - the hosted/SaaS surface (was/never "Loki Cloud").
- **Autonomi Enterprise** - the enterprise offering (SSO, RBAC, audit, SLAs).
- **Autonomi** (VaaS) - the hosted Verification-as-a-Service product (the
  ~/loki-vaas scaffold's *product* name is Autonomi-branded; the engine is Loki).
- Any paid tier, support plan, or commercial license: Autonomi.

Each commercial product carries a **"powered by Loki"** (or "runs Loki" /
"built on Loki") attribution so the engine lineage stays visible - the Copilot/
GPT pattern. Example: "Autonomi Cloud, powered by Loki."

## Mapping table (rename these going forward)

| Old / ambiguous | New | Notes |
|---|---|---|
| Loki Cloud | **Autonomi Cloud** (powered by Loki) | commercial hosted |
| Loki Enterprise (as a *product/offering* name) | **Autonomi Enterprise** (powered by Loki) | the paid offering |
| Loki VaaS / Loki Verification Cloud | **Autonomi Verify** (VaaS), powered by Loki | ~/loki-vaas product brand (renamed 2026-06-12) |
| "Loki, the company" | **Autonomi** | the company is Autonomi |
| Loki SaaS / Loki Pro / Loki Business | **Autonomi Cloud** / **Autonomi Enterprise** | no paid tier wears "Loki" |
| Loki Mode (the CLI/SDK/agent) | **Loki Mode** (unchanged) | the agent keeps its name |
| `loki` CLI binary | `loki` (unchanged) | never rename the binary |

## Tricky cases (decided)

1. **The `loki enterprise` CLI subcommand** (`loki enterprise token …`, `loki
   enterprise audit …`): the COMMAND stays `loki enterprise` for backward
   compatibility (renaming breaks every user/script). It is the Loki CLI's
   gateway to enterprise *features*. But in PROSE / docs / marketing, the
   enterprise *offering* it unlocks is branded "Autonomi Enterprise." So:
   command = `loki enterprise`; product = Autonomi Enterprise. Doc pattern:
   "Use `loki enterprise` to manage your **Autonomi Enterprise** license."
   (A future `autonomi` alias for the command MAY be added as a superset, but
   `loki enterprise` is never removed.)

2. **Published artifact IDs** (npm `loki-mode`, Docker `asklokesh/loki-mode`,
   brew `loki-mode`, MCP `io.github.asklokesh/loki-mode`): KEEP. These are
   install identifiers; the brand on the *page* can say "Loki Mode (by
   Autonomi)" but the package name does not change. Renaming = broken installs.

3. **The dashboard/web-app chat**: the agent in the chat box is "Loki"
   everywhere - in the OSS dashboard AND inside Autonomi Cloud. The container
   product (local dashboard = Loki Mode dashboard; hosted = Autonomi Cloud) is
   what changes, not the agent's name.

4. **autonomi.dev website**: company + commercial = Autonomi branding; the
   product you download is "Loki Mode"; the assistant is "Loki". The hero can be
   "Autonomi - autonomous software delivery, powered by Loki" with a "Download
   Loki Mode (free)" CTA and a "Autonomi Cloud / Enterprise" commercial CTA.

5. **License/legal**: BUSL-1.1 is held by Autonomi; "Free for personal/internal/
   academic use" applies to Loki Mode (source-available); commercial licensing = Autonomi.
   Keep "source-available," never "open source" (BUSL is not OSI-approved).

## Taglines (approved patterns)

- "Loki Mode - the autonomous coding agent. Free and source-available."
- "Autonomi - autonomous software delivery for teams and enterprises. Powered by Loki."
- "Autonomi Cloud - hosted Loki, managed for your team."
- "Autonomi Enterprise - Loki with SSO, RBAC, audit, and SLAs."
- "Chat with Loki." (the assistant, anywhere)

## Going forward

Any new product, page, heading, or release note must place itself on the correct
side of this line:
- Free / OSS / CLI / SDK / agent / chat -> **Loki Mode** / **Loki**.
- Paid / hosted / cloud / enterprise / company -> **Autonomi** (+ "powered by Loki").

Update this file if the founder revises the rule; this file is the single source
of truth for naming.
