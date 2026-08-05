# Plans Index

This index maps each historical plan doc to its status. Plan docs are kept as design history; a 'shipped' plan's feature is live in the code.

| Plan | Status | Notes |
|---|---|---|
| BRANCH-LIFECYCLE-PLAN.md | shipped | Feature-branch-by-default + CI/CD-aware deploy; `feature_branch` logic in `autonomy/run.sh`. |
| BUILD-HUD-PLAN.md | shipped | Live in-terminal build HUD; `LOKI_HUD` / `[HUD]` in `autonomy/run.sh`, CHANGELOG "Live in-terminal build HUD". |
| CONFIG-FILE-PLAN.md | shipped | Unified config file; `--config` / `--vars` / `--env-file` flags in `autonomy/loki`. |
| CRASH-REPORTING-PLAN.md | shipped | Crash-reporting + auto-fix; `cmd_crash()` in `autonomy/loki` (`loki crash`). |
| DEPLOY-PLAN.md | shipped | `loki deploy` advisory print-only; CHANGELOG "`loki deploy`: advisory, print-only deploy guidance". |
| FAILURE-MEMORY-PLAN.md | shipped | Failure-memory loop; `FailureMode` schema in `memory/schemas.py`. |
| FEAT-PRDREUSE-DOCKER-PLAN.md | shipped | PRD-reuse + Docker batch; Docker dashboard/port + PRD-reuse present in `autonomy/loki`. |
| MERGE3-PLAN.md | shipped | Purple-Lab-into-Dashboard integration; `/lab/` mount in `dashboard/server.py`. |
| P0-SWEEP-PLAN.md | shipped | Verification-credibility sweep; wired detectors are part of the 8-gate system. |
| P2-SPEC-ROBUSTNESS-PLAN.md | shipped | Spec interrogation gate + assumption ledger; part of quality-gates spec robustness. |
| PRD-REUSE-DONE-RECOGNITION-PLAN.md | shipped | PRD-reuse done-recognition gate; reuse-then-verify behavior in the engine. |
| PREVIEW-LINK-PLAN.md | shipped | `loki preview --public`; `_preview_public` in `autonomy/loki`, CHANGELOG "`loki preview --public`". |
| R10-MARKETPLACE-PLAN.md | shipped | Agent/template marketplace (install-from-source); `loki template` marketplace in `autonomy/loki`. |
| R6-ROLLBACK-CHECKPOINT-PLAN.md | shipped | 1-click rollback + checkpoint UX; `cmd_rollback()` / `rollback)` dispatch in `autonomy/loki`. |
| R7-ZERO-CONFIG-FIRST-RUN-PLAN.md | shipped | Zero-config first run; welcome/first-run path in `autonomy/loki`. |
| R8-SHAREABLE-TEAM-ASSETS-PLAN.md | shipped | Exportable/importable team assets; `cmd_export()` / `cmd_import()` in `autonomy/loki`. |
| R9-OPEN-CORE-HOOKS-PLAN.md | shipped | Open-core seams (BUSL-1.1); open-core seam references in `autonomy/loki`. Seams only; no hosted backend (by design). |
| RARV-C-100X-PLAN.md | active | v8.0.0 native-primitives arc; v8 lives on the `feature/v8-agent-sdk` branch, not yet merged to main. |
| RARV-C-LOOP-EFFICIENCY-PLAN.md | superseded | Self-marked SUPERSEDED by RARV-C-100X-PLAN.md (v8.0.0 arc); anchors drifted, kept as history. |
| SHAREABLE-PROOF-PLAN.md | shipped | Opt-in shareable proof-of-run (v7.19.3) preserving zero-egress posture. |
| SONNET5-DEFAULT-PLAN.md | shipped | Sonnet 5 default execution model; `v7.104.0: Sonnet 5 is the default` in `providers/claude.sh`. |
| TASKLIST-ACCURACY-PLAN.md | shipped | Dashboard task-list accuracy fix; task-list handling in `dashboard/server.py`, CHANGELOG v7.104.x task-list fixes. |
| UNCERTAINTY-ESCALATION-PLAN.md | shipped | Uncertainty-gated escalation (v7.19.2); uncertainty escalation logic in `autonomy/run.sh`. |
| VERIFIED-COMPLETION-PLAN.md | shipped | Verified completion (v7.19.1); verified-completion gate in `autonomy/run.sh` + `autonomy/completion-council.sh`. |
| WELCOME-OPENER-PLAN.md | shipped | Welcome opener ("magic opener"); `welcome` path in `autonomy/loki`. |
| V8-AGENT-SDK-PLAN.md | shipped | The v8 Anthropic SDK runtime migration; shipped on `feature/v8-agent-sdk` as v8.0.0 + v8.1 (`loki-ts/src/runner/sdk_invoker.ts`, `sdk_mode.ts`, CHANGELOG v8.0.0/v8.1). Feature-branch-only, not yet merged to main. |
| V8-SDK-RESEARCH-RAW.md | shipped | Research notes underpinning V8-AGENT-SDK-PLAN; design history for the v8 SDK arc. |
