# Competitor Deployment Models: Trigger, Self-Hosting, Verification

Research date: 2026-08-08. All claims below carry a source URL and were accessed
on 2026-08-08 unless otherwise stated.

Scope: for each vendor, (a) how a build or agent run is triggered in a deployed
team setting, (b) whether it can run inside a customer's own network and what
exactly moves there, and (c) whether the product exposes any artifact that
verifies its own output.

This document reports what each vendor documents. It does not compare vendors
against each other or against any product of ours, and does not rank them.

## Summary table

| Vendor | Trigger | Self-hosting | Inference routing | Verification surface |
|---|---|---|---|---|
| Factory AI | CLI (`droid`), headless `droid exec`, GitHub Action on `@droid` comments, Slack, Linear, web/desktop app | Yes, documented: cloud-managed, hybrid, and fully airgapped patterns | Customer-controlled: "Factory does not need to broker model access"; BYOK with custom `baseUrl` | Not documented publicly. `droid exec` emits JSON with a `session_id`; no receipt or attestation language on the page |
| Cognition / Devin | Slack `@Devin` mention and slash commands, GitHub PR comments, REST API `POST /v3/organizations/{org}/sessions`, web UI | No. Two Cognition-operated models only (Enterprise Cloud, Customer Dedicated single-tenant VPC). Prior self-hosted offering placed in maintenance mode 2025-05-12 | UNKNOWN, not documented publicly | Not documented publicly |
| Replit Agent | Web/app UI chat, Slack `@Replit` mention, MCP server tool `create_app_from_prompt` | Not documented publicly. Marketing page mentions "Dedicated GCP project, single-tenant option" | Vendor-pinned. Agent modes (Lite/Economy/Power), no documented model selection or routing | Not documented publicly |
| 8090 | UNKNOWN. Docs describe authoring Requirements/Blueprints/Work Orders; Agent Skill is invoked from a third-party coding agent (e.g. Cursor `/software-factory`) | UNKNOWN, no public docs on self-hosting as of 2026-08-08 | UNKNOWN. Platform is agent-facing; which model executes is not documented | Not documented publicly. A "Validator" module is documented, but it converts user feedback into tasks, not output attestation |

## Factory AI

Docs root: https://docs.factory.ai/ (accessed 2026-08-08)

### (a) Trigger

Multiple documented surfaces.

Headless CLI, https://docs.factory.ai/droid-exec/overview (accessed 2026-08-08):

> "Factory's headless execution mode designed for automation workflows. Unlike
> the interactive CLI, `droid exec` runs as a one-shot command that completes a
> task and exits, making it ideal for CI/CD pipelines, shell scripts, and batch
> processing."

Invocation is `droid exec [options] [prompt]`, with `-f prompt.md` for file
input, `--auto <level>` for autonomy, and `--session-id` for continuation.
Output formats documented: text (default), JSON, and raw JSON-RPC.

GitHub, https://github.com/Factory-AI/droid-action (official `Factory-AI` org,
accessed 2026-08-08). The action triggers on `issue_comment` (created),
`pull_request_review_comment` (created), `pull_request_review` (submitted),
`pull_request` (opened, edited), and `issues` (opened, assigned). It scans
issue comments, PR descriptions, and review comments for `@droid` commands.
Documented commands include `@droid fill`, `@droid review`, `@droid security`,
and `@droid security --full`. Of `@droid review` the repo says it "performs an
automated code review, surfaces potential bugs, and leaves inline comments
directly on the diff".

Slack and Linear are documented as integration surfaces for delegating tasks
(https://docs.factory.ai/changelog/1-8, accessed 2026-08-08). Interactive use
is via the `droid` CLI, the Factory desktop app, and app.factory.ai.

### (b) Self-hosting

Documented in detail, and the strongest self-hosting story of the four.
https://docs.factory.ai/enterprise/network-and-deployment (accessed 2026-08-08)
describes three patterns: cloud-managed, hybrid, and fully airgapped.

On the airgapped pattern, verbatim:

> "Factory cloud is not reachable at runtime; binaries and configuration are
> imported through your own artifact repositories or offline processes."

In the hybrid pattern, droid runs within customer infrastructure (VMs,
containers, CI runners, remote dev environments) with Factory cloud used
optionally for coordination. In the cloud-managed pattern, droid runs on
developer machines and build infrastructure while Factory cloud provides
orchestration; cloud-managed deployments reach `*.factory.ai`.

So what moves into the customer network is execution in all patterns, and in
the airgapped pattern the vendor control plane is out of the runtime path
entirely.

### (b, cont.) Inference routing

Customer-routable. Verbatim from the same page:

> "LLM traffic can still be routed through your own gateways and providers;
> Factory does not need to broker model access."

BYOK is separately documented at https://docs.factory.ai/cli/byok/overview
(accessed 2026-08-08):

> "Your API keys remain local and are not uploaded to Factory servers."

and

> "Use your own OpenAI or Anthropic keys, connect to any open source model
> providers, or run models locally on your hardware."

Supported shapes are the Anthropic Messages API, the OpenAI Responses API, and
the OpenAI Chat Completions API, with a configurable `baseUrl`; the page names
OpenRouter, Fireworks, Together AI, Ollama, and vLLM among supported providers.

### (c) Verification

Not documented publicly. A targeted verbatim query against
https://docs.factory.ai/droid-exec/overview for any mention of receipt,
attestation, signature, signed record, audit log, provenance, or verification
of the agent's own output returned NOT PRESENT (accessed 2026-08-08).

What does exist is execution metadata, not attestation: JSON output carries a
`session_id` field, and the docs note that for automated pipelines you can
direct the agent to write specific artifacts such as JSON files, CSV reports,
or markdown documents. Those are agent-authored outputs, not independent
records of what the agent did.

Note: `@droid review` and `@droid security` verify *the repository's* code.
That is a different thing from the product verifying its own output, which is
what (c) asks about.

## Cognition / Devin

### (a) Trigger

Slack, https://docs.devin.ai/integrations/slack (accessed 2026-08-08):

> "Tag **@Devin** in Slack as soon as bugs, feature requests, and questions
> come in."

Also documented on that page: slash commands `/ask-devin [your question]` and
`/dana [your data question]`; Slack message shortcuts via right-click or the
overflow menu ("Ask Devin about this", "Create a new session"); and bang
keywords `!ask`, `!deep`, `!fast`, `!ultra` placed anywhere in a message.

REST API, https://docs.devin.ai/api-reference/overview (accessed 2026-08-08).
Sessions are created with `POST https://api.devin.ai/v3/organizations/$DEVIN_ORG_ID/sessions`,
authenticated with a service user's `cog_`-prefixed API key. The page states:

> "The Devin API enables you to integrate Devin into your applications,
> automate workflows, and build powerful tools."

Webhooks are not documented on the API overview page. Cognition's marketing
blog describes event-driven triggering (on a failed build, on an assigned
Linear ticket) and GitHub Actions workflows that call the API on PR events,
but that is marketing and example-code copy rather than a documented webhook
product surface. Treated here as: API plus caller-supplied glue.

### (b) Self-hosting

No. This is the clearest negative finding in the set, and it is a change from
an earlier state.

https://docs.devin.ai/enterprise/deployment/overview (accessed 2026-08-08)
documents two options, both Cognition-operated. Verbatim:

> "In the Enterprise Cloud model, both Devin's brain and Devbox run in
> Cognition's secure, multi-tenant cloud."

> "In the Customer Dedicated Deployment model, Cognition hosts Devin in an
> auto-scaling, customer-isolated environment within a single-tenant VPC."

And decisively on the control plane, verbatim:

> "The Brain: A stateless, cloud-based service that powers Devin's
> intelligence, always residing in Cognition's Cloud."

Customer Dedicated is therefore vendor-hosted single-tenancy, not customer
self-hosting: Cognition runs it, and the Brain never leaves Cognition's cloud.
The page documents no self-hosted option.

A prior self-hosted offering was discontinued.
https://devin.ai/blog/self-hosted-deployment-maintenance-mode (dated
2025-05-12, accessed 2026-08-08), verbatim:

> "By maintenance mode, we will of course continue to support our current
> self-hosted customers until the end of their term and provide great financial
> incentives to switch to and adopt our other deployment offerings, but we are
> no longer investing in feature development or bringing on new customers to
> the self-hosted platform."

Caveat on attribution, recorded deliberately: this post sits on devin.ai and is
Devin-titled, but it links to a Windsurf blog post ("see Wave 8"), and Cognition
acquired Windsurf. On direct query the page does not explicitly name which
product the self-hosted offering belongs to. The quoted sentence is accurate as
Cognition's position on its self-hosted platform; readers should not assume it
names the Devin product specifically. The Devin-specific conclusion above rests
on the deployment docs, not on this post.

### (b, cont.) Inference routing

UNKNOWN. The deployment docs describe Devin as a compound AI system but do not
disclose the inference provider, and document no customer-side model routing,
gateway, or BYOK option. Not documented publicly as of 2026-08-08.

### (c) Verification

Not documented publicly as of 2026-08-08. No receipt, attestation, or signed
record surface was found in the API reference, deployment docs, or Slack
integration docs.

## Replit Agent

### (a) Trigger

Three documented surfaces. The primary one is UI chat, but Replit is not
UI-only, and an earlier reading of the Agent overview page alone would have
suggested it was.

Web/app UI, https://docs.replit.com/features/agent/overview (accessed
2026-08-08): "In the Project Editor, just start chatting."

Slack, https://docs.replit.com/features/platforms/slack (accessed 2026-08-08),
verbatim:

> "Mention @Replit in Slack to turn a prompt into a working prototype"

> "Once it's installed, mention **@Replit** in any channel to start building."

MCP server, https://docs.replit.com/platforms/mcp-server (accessed 2026-08-08).
This is the programmatic trigger. Documented tools:

- `create_app_from_prompt` — "Create a new Replit App from a natural language
  description. Replit Agent immediately starts building the app."
- `update_app_using_prompt` — "Make changes to an existing Replit App."
- `ask_question` — "Ask Replit Agent about the current app."

An Enterprise Admin API exists
(https://docs.replit.com/teams/admin-api) but is scoped to account usage,
workspaces, members, and projects, not to starting Agent runs.

No GitHub-webhook or PR-comment trigger is documented.

### (b) Self-hosting

Not documented publicly as of 2026-08-08. A category scan of Replit's full
documentation index (https://docs.replit.com/llms.txt, accessed 2026-08-08)
returned NOT PRESENT for self-hosting, on-premise, and VPC. Absence from the
index is strong evidence of absence from the documentation, though not proof of
absence from the product.

The only adjacent datum is marketing copy, not technical documentation:
https://replit.com/enterprise (accessed 2026-08-08) lists "Dedicated GCP
project, single-tenant option" under a sales-assisted Enterprise plan. That
phrase does not establish where the deployment runs or who operates it, and the
page does not clarify. Recorded as marketing copy, not a documented deployment
model.

### (b, cont.) Inference routing

Vendor-pinned, as far as the docs go. The Agent overview documents modes (Lite,
Economy, Power) and a Turbo toggle for Power, which concern performance and
cost rather than model selection; no model choice or routing is documented.

One page is easy to misread here:
https://docs.replit.com/features/integrations/replit-ai-integrations describes
using "AI models from OpenAI, Anthropic, Google, and more without needing your
own API key". That is about models available to *the app being built* through
Replit's integrations. It is not about routing the Agent's own inference, and
it points the opposite way from BYO-inference: Replit supplies the key.

### (c) Verification

Not documented publicly as of 2026-08-08.

## 8090

8090 Solutions Inc., product "Software Factory". Docs at
https://www.8090.ai/docs/general/introduction (accessed 2026-08-08).

This vendor has the thinnest public technical documentation of the four, and
most of what circulates about it is press coverage of its 135M USD Series A
rather than product docs. Findings are correspondingly limited.

### (a) Trigger

UNKNOWN as a build/agent-run trigger in the sense the question asks.

What is documented is a document-authoring workflow rather than a run trigger.
The docs describe modules: Requirements ("Create detailed PRDs capturing
requirements, features, and goals"), Blueprints (organizing features into a
hierarchy of Feature Nodes), Work Orders (generating tasks with
codebase-aware implementation plans), and Validator.

The one execution-adjacent surface is Agent Skill,
https://www.8090.ai/docs/opinions/agent-skill (accessed 2026-08-08):

> "Agent skills are modular bundles of instructions, scripts, and resources
> that an agent can load at runtime to perform specific tasks with the right
> procedures and context."

The page documents invoking it from Cursor with `/software-factory`, and notes
that for other agents the skill loads when Software Factory elements are
referenced in a prompt. On direct query, the page returned NOT PRESENT for both
"does the customer bring their own agent or model" and "how a build gets
triggered".

The shape this suggests, stated as inference and labeled as such, not as a
finding: 8090 appears to be a platform that third-party coding agents connect
*into*, rather than one that itself dispatches agent runs. Press coverage
(SiliconANGLE, 2026-06-29) says Software Factory "uses third-party AI agents to
turn user-created documents into code". That is journalism, not vendor
documentation, and it is recorded here only because the docs do not settle the
question.

No CLI, API, GitHub, or Slack trigger is documented publicly.

### (b) Self-hosting and inference routing

UNKNOWN, no public docs on self-hosting as of 2026-08-08. The documentation
navigation (General, Opinions, Raw Materials, Modules, Administration,
Resources) contains no deployment, architecture, security, or infrastructure
section. Inference routing is likewise undocumented; if the third-party-agent
model is accurate, the executing model would be whichever agent the customer
connects, but that is not documented and is not asserted here.

### (c) Verification

Not documented publicly as of 2026-08-08. The "Validator" module name is
suggestive but is documented as converting user feedback into actionable
development tasks, which is a feedback-intake function, not verification of the
product's own output.

## Anthropic Claude Code self-hosted (reference)

Source: https://code.claude.com/docs/en/self-hosted-environments (accessed
2026-08-08). This section was verified against the page rather than assumed.

### Trigger model

Sessions are started from Anthropic surfaces, then routed to customer compute.
Verbatim:

> "A cloud session is any session that runs somewhere other than the
> developer's machine: developers start them from claude.ai, the mobile and
> desktop apps, the terminal with `claude --cloud`, and scheduled routines, and
> by default they execute on Anthropic's infrastructure."

At session start the developer picks an environment. Verbatim:

> "When a developer starts a cloud session, the session-start UI shows an
> environment picker listing Anthropic-hosted environments alongside any your
> organization has created. If they choose yours, Anthropic's control plane
> places the session on your environment's queue, where a runner claims it,
> clones the repository the developer chose, and starts a Claude Code process
> on your host to run it."

Documented surfaces are Claude Code on the web, mobile and desktop apps,
scheduled routines, and the terminal via `claude --cloud` or a scripted
`--environment` dispatch. Claude Tag, Claude Security, and Code Review sessions
are documented as not routing to self-hosted environments yet.

### Control plane stays Anthropic-hosted, execution moves

Verbatim, and this is the sentence that establishes it:

> "Session orchestration, queueing, and the claude.ai interface remain
> Anthropic-hosted: a self-hosted environment moves session execution into your
> network, not the control plane."

Supporting detail, verbatim:

> "Repository checkouts, build artifacts, secrets, and any files a session
> creates or modifies stay on the machines you provision. The conversation
> itself, including prompts, responses, and tool results, goes to
> `api.anthropic.com` for model inference, and Anthropic stores the session
> transcript so you can resume the session from another supported surface."

Direction of connectivity, verbatim:

> "Anthropic never connects into your network."

The runner polls `api.anthropic.com` for work; all connections are outbound
HTTPS, with no inbound connectivity from Anthropic required.

### Inference cannot be routed elsewhere

Stated twice on the page. Verbatim, in the limitations list:

> "Model inference: sessions use the Anthropic API, and inference can't be
> routed through Amazon Bedrock, Google Cloud's Agent Platform, Microsoft
> Foundry, or an LLM gateway."

And with the mechanism, verbatim:

> "Model inference uses the Anthropic API. The control plane delivers the API
> endpoint to each session, and the session authenticates with an
> Anthropic-issued, session-scoped OAuth token, so inference can't be routed
> through Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, or
> an LLM gateway in self-hosted environments."

Other documented constraints: public beta on Team and Enterprise plans, off by
default; unavailable for organizations with Zero Data Retention enabled;
repository checkout is from GitHub; sessions bill against the organization's
Claude Code usage as Anthropic-hosted sessions do.

One related surface worth noting for the verification question: the page links
"Verify session identity" (/docs/en/self-hosted-environments-identity), which
lets a customer's own services validate a session token before granting access.
That is workload identity for access control, not an attestation of the
session's output, and it was not fetched for this report.

## What we could not establish

Every UNKNOWN, with the reason.

1. **Devin inference routing.** No public documentation of the inference
   provider or of any customer-side routing, gateway, or BYOK option as of
   2026-08-08. The deployment docs describe a compound AI system without naming
   providers.

2. **Devin self-hosted-post attribution.** The maintenance-mode post is
   Devin-titled and Devin-hosted but links to a Windsurf post and does not
   explicitly name which product's self-hosted offering it discontinues. The
   quote is reported; the product attribution is left open.

3. **Devin webhook triggering.** The API overview documents no webhook or
   push-event mechanism. Event-driven triggering appears only in marketing blog
   posts and example GitHub Actions glue. Whether a first-class webhook surface
   exists is not documented publicly.

4. **Replit self-hosting.** NOT PRESENT across the full documentation index for
   self-hosting, on-premise, and VPC. The "Dedicated GCP project, single-tenant
   option" phrase appears only in marketing copy and does not establish who
   operates the deployment or where it runs.

5. **Replit Agent's underlying models.** Not documented; modes are described in
   terms of capability and cost, not models.

6. **8090 trigger mechanism.** No documented CLI, API, GitHub, or Slack
   trigger. Docs cover document authoring and an Agent Skill loaded by a
   third-party agent. Whether 8090 itself dispatches runs is not documented
   publicly.

7. **8090 self-hosting and inference routing.** No public docs on deployment,
   architecture, or infrastructure as of 2026-08-08; the documentation has no
   such section.

8. **Verification surfaces for all four vendors.** No vendor documents a
   receipt, attestation, signed record, or provenance artifact covering its own
   output. For Factory this was confirmed by a targeted verbatim query
   returning NOT PRESENT; for the others it is absence across the pages read.
   In all cases this is "not documented publicly", not proof of absence from
   the product.

## Method

Searched via web search and fetched official documentation directly. Preferred
`docs.<vendor>` and official changelogs over marketing pages and press
coverage, and labeled the latter explicitly wherever they are the only source.

Pages reached (all 2026-08-08): docs.factory.ai root, `/cli/byok/overview`,
`/enterprise/network-and-deployment`, `/droid-exec/overview`;
github.com/Factory-AI/droid-action; docs.devin.ai `/integrations/slack`,
`/api-reference/overview`, `/enterprise/deployment/overview`;
devin.ai/blog/self-hosted-deployment-maintenance-mode; docs.replit.com
`/llms.txt`, `/features/agent/overview`, `/features/platforms/slack`,
`/platforms/mcp-server`, `/features/integrations/overview`; replit.com/enterprise;
www.8090.ai root, `/docs/general/introduction`, `/docs/opinions/agent-skill`;
code.claude.com/docs/en/self-hosted-environments.

Not reached: `docs.factory.ai/enterprise/architecture` returned HTTP 404; the
correct path is `/enterprise/network-and-deployment`. Nothing was paywalled.
No vendor sales contact was made, which is the reason several enterprise
deployment questions resolve to UNKNOWN rather than to an answer.

Two methodology notes that materially changed findings:

- Page fetches are summarized by a model, and summaries twice produced
  plausible sentences that were not on the page: a claim that all three Factory
  patterns route inference to customer gateways, and a claim that `droid exec`
  "can produce verifiable records". Both were re-queried with a strict
  copy-only prompt. The Factory inference sentence was confirmed as real page
  text in narrower form; the droid-exec verification claim returned NOT PRESENT
  and was discarded. Every quotation in this document survived a verbatim
  re-query or was returned under a copy-only prompt.

- Reading a single overview page understates trigger surfaces. The Replit Agent
  overview page alone implies UI-only; the full documentation index revealed
  both a Slack trigger and an MCP `create_app_from_prompt` tool that starts a
  build programmatically. Where a vendor publishes an index or `llms.txt`, that
  is the better instrument for absence claims than any number of page reads.
