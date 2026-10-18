# Quickstart (5 minutes)

`loki start` is the primary path. This page gets you from install to a
verified result, then shows the interactive alternative and the small-change
path.

## 1. Install

```bash
npm install -g loki-mode
```

You need Node.js 18+ (20+ recommended), Python 3.8+, git, jq and curl. Claude
Code (`claude`) is the default provider and is needed for the default path:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Other coding CLIs (codex, cline, aider, opencode) are optional. Full list:
[INSTALLATION.md](INSTALLATION.md).

## 2. Set up

```bash
cd your-repo
loki setup          # checks tools, Claude login, provider, model route, spend cap
```

`loki setup --yes` accepts defaults. `loki doctor --fix` creates state
directories and a default config and prints exact commands for anything
missing; it never runs sudo.

## 3. Run

```bash
loki start "add rate limiting to /api/login"
```

Also accepted: `loki start prd.md`, `loki start owner/repo#123`, and a
one-word brief as `loki start <word>`. Add `--no-pr` to skip the pull request.
The PR uses your existing `gh auth login` (and git) credentials; no extra token
is needed. On a repo you cannot push to, Loki pushes the branch to your fork and
opens the PR upstream from it (the branch is public on your fork); a draft
outcome (anything but VERIFIED) stays on the fork, and Loki posts no status
comment on that repo's issue.
`LOKI_PR_FORK=0` turns the fork fallback off.
Preview the route first with `loki route start prd.md`.

The spend cap defaults to $100 when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is
set, and to no dollar cap on a subscription login. Change it with
`--max-cost <usd>`.

## 4. Read the summary

Every run ends with one block:

```
Result:   verified
Files:    3 changed (+42 -5)
Cost:     $0.42
Elapsed:  4m12s
Receipt:  .loki/runs/<run-id>/receipt.json
next:     loki diff
```

`Cost` reads `(estimated)` when the provider did not report it and `not
measured` when unknown. The `next:` line names the one command to run now.
`loki verify` re-checks the receipt; `loki undo` reverts the run. Exit codes
are in [exit-codes.md](exit-codes.md): usage errors are 64, and a CI gate
should be `loki verify || fail`.

## 5. Talk to a run: loki chat --attach

```bash
loki chat --attach     # joins the running or last `loki start` session
```

Inside: `/status`, `/steer <text>`, `/diff`, `/verify`, `/receipt`, `/stop`.
`loki chat` on its own is the interactive alternative: it starts in Plan mode
(read-only), `/build` allows edits, and `/run <brief>` starts a normal
`loki start` run with the chat's model and provider. Bare `loki` does not open
chat.

## 6. Small changes: loki edit

```bash
loki edit "rename fooBar to foo_bar"
loki edit src/foo.ts "rename X to Y"
loki edit --verify --commit src/a.ts "add null checks"
```

One pass, no plan, council or PR. It prints the diff and one line with cost and
time. Use `loki quick "<task>"` when you want a verify loop.

## 7. Local and other models

```bash
loki models --local                              # finds Ollama, LM Studio, llama.cpp, vLLM
LOKI_MODEL_ROUTE=ollama/qwen3-coder loki start prd.md
LOKI_MODEL_ROUTE=openrouter/deepseek/deepseek-v3.2 loki start prd.md   # needs OPENROUTER_API_KEY
loki start --provider codex prd.md               # another coding CLI
```

Routes: `openrouter`, `ollama`, `lmstudio`, `llamacpp`, `vllm`, and `custom`
(set `LOKI_MODEL_BASE_URL`). They run through the Claude harness, so cost,
kill blocking and receipts still apply.

## Next

[User guide](v10/GUIDE.md), [core verbs](CLI-CORE-VERBS.md),
[custom agents](v10/GUIDE.md#custom-agents), [comparison with
opencode](COMPARE-OPENCODE.md).
