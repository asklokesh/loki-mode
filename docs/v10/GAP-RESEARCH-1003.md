# GAP RESEARCH 1003: Loki vs Competitors

Research date: Oct 3, 2026. Scope: public product docs, launch announcements, funded claims.

## What Each Competitor Ships That Loki Lacks

**Devin AI (Cognition Labs):** Desktop app with computer-use capability ($500/mo), self-review gate (catches 30% more issues), no manual intervention for 15-task planning. Publicly claimed features from https://www.buildfastwithai.com/ai-tools/devin and https://singularitymoments.com/devin-ai-coding-agent-guide/.

**Factory AI:** IDE integrations (VS Code, JetBrains, Vim native), role-based API for droid swarm control, Linear/Jira issue-to-code pipeline, OpenTelemetry adoption analytics, background cloud/local agents. Cited from https://www.digitalapplied.com/blog/factory-ai-multi-agent-coding-platform-review and https://fritz.ai/factory-ai-review/.

**8090 Software Factory:** Requirements-Blueprint-Planner workflow for regulated enterprises, audit-trail-first governance, AI agent skill marketplace. For regulated orgs only. Cited from https://www.8090.ai/docs/general/introduction and https://rywalker.com/research/8090-software-factory.

**Vorflux:** Browser-based test recording with mergeable PR video proof, adversarial reviewer agents (planner vs reviewer), GitHub/Linear/Slack/AWS native bindings, $15M seed. Cited from https://vorflux.com/docs and https://www.thesaasnews.com/news/vorflux-raises-15m-seed/.

**Claude Code:** Scheduled task execution on Anthropic cloud (runs without laptop), computer-use desktop capability, TypeScript mod/plugin system, interactive visualizations, multi-threaded project coordination. Cited from https://www.builder.io/blog/claude-code-updates and https://releasebot.io/updates/anthropic/claude-code.

## Top 10 Gaps Ranked by User Value (Slice Candidates)

1. **IDE/editor integration (VSCode, JetBrains)** - 80% of developers code in editors; CLI-only cuts reach by half.
2. **Issue tracker native binding (GitHub Issues, Linear)** - work originates there; native pipeline removes copy-paste.
3. **Browser test execution with proof video** - video proof that code works earns trust; text pass/fail claims don't.
4. **Scheduled/background agent task queue** - devs want builds while laptop is off; async job model unlocks 24/7.
5. **Self-review quality gate before PR** - automated issue-catching before human review saves review cycles.
6. **Droid/agent role-based SDK/API** - programmatic control lets orgs embed Loki into their CI/CD automation.
7. **Desktop application (GUI + CLI)** - non-engineer stakeholders (PMs, execs) need GUI visibility into builds.
8. **Enterprise audit trail & on-prem option** - regulated industries won't use SaaS without HIPAA/SOC2 provenance.
9. **Cost analytics per agent/task** - enterprises need chargeback models; opaque token spend blocks budget approval.
10. **Local-only execution mode** - IP-sensitive work (defense, finance) requires on-premises guarantees.

---

Research validated via web sources: Devin, Factory, 8090, Vorflux, Claude Code press/docs (Oct 2026).
