# Loki Mode - Multi-Agent System for SWE-bench

## Overview

**Loki Mode** is a multi-agent system that works with Claude Code, OpenAI Codex, and Google Gemini. It orchestrates specialized AI agents to solve software engineering tasks. This template records a PATCH GENERATION run on SWE-bench Lite.

## Results (patch generation only, NOT a resolve rate)

IMPORTANT: these numbers count whether a candidate diff was PRODUCED, not
whether it fixes the issue. The official SWE-bench evaluator (apply patch,
run the repo test suite) was never run on these patches, so Loki Mode has no
SWE-bench resolve rate, and the figures below must not be compared against
other systems' resolution scores.

| Metric | Value |
|--------|-------|
| Patch generation rate | 99.67% (299/300 diffs produced) |
| Patches generated | 299 |
| Total Problems | 300 |
| Verified as fixing the issue | 0 measured (evaluator not run) |
| Fixed by RARV Retry | 0 |
| Average Attempts | 1.0 |
| Total Time | ~3.5 hours |
| Avg Time/Problem | 42s |

## System Architecture

Loki Mode uses a **4-agent pipeline** with a RARV (Reason-Act-Reflect-Verify) cycle:

```
Issue -> [Architect] -> [Engineer] -> [QA] -> [Reviewer] -> Patch
                ^                                |
                |______ RARV Retry Loop ________|
```

### Agent Roles

| Agent | Role | Model | Timeout |
|-------|------|-------|---------|
| **Architect** | Analyze issue, identify files, design fix approach | Claude Opus 4.5 | 120s |
| **Engineer** | Generate patch based on architect's analysis | Claude Sonnet 4.5 | 300s |
| **QA** | Validate patch format (diff headers, hunks, paths) | Rule-based | 5s |
| **Reviewer** | Analyze format issues, provide feedback for retry | Claude Sonnet 4.5 | 60s |

### RARV Cycle

The RARV (Reason-Act-Reflect-Verify) cycle enables self-correction:

1. **Reason**: Architect analyzes the issue
2. **Act**: Engineer generates a patch
3. **Reflect**: QA validates the patch format
4. **Verify**: If invalid, Reviewer provides feedback and Engineer retries

Maximum 3 retry attempts per problem.

## Comparison with Baselines

Patch GENERATION rates only (diffs produced; correctness never evaluated):

| System | SWE-bench Lite patch generation |
|--------|--------------------------|
| Loki Mode (multi-agent) | 99.67% (299/300 diffs produced) |
| Direct Claude (single agent) | 99.67% (299/300 diffs produced) |

After timeout optimization, the multi-agent RARV pipeline matches single-agent
generation throughput. Neither row says anything about whether the patches are
correct; only the official evaluator can establish that, and it was not run.

## Methodology

1. **No repository cloning**: Patches are generated based solely on the issue description and hints
2. **No test execution during generation**: Patches are validated for format only during generation
3. **Deterministic pipeline**: Same agent sequence for all problems
4. **Full trajectory logging**: All prompts and outputs are recorded for transparency

## Repository

- **GitHub**: [asklokesh/loki-mode](https://github.com/asklokesh/loki-mode)
- **License**: Business Source License 1.1 (BUSL-1.1, converts to Apache 2.0 in 2030). This submission template was authored when the project was MIT-licensed; subsequent submissions are under BUSL-1.1.
- **Submission Version**: 2.25.0 (historical -- pinned to the SWE-bench submission point)

## Running Loki Mode

```bash
# Clone the repository
git clone https://github.com/asklokesh/loki-mode.git

# Run SWE-bench with Loki Mode
./benchmarks/run-benchmarks.sh swebench --execute --loki

# Run with limit for testing
./benchmarks/run-benchmarks.sh swebench --execute --loki --limit 10
```

## Files in This Submission

```
evaluation/lite/20260105_loki_mode/
├── README.md           # This file
├── metadata.yaml       # Submission metadata
├── all_preds.jsonl     # Predictions in JSONL format
├── trajs/              # Reasoning trajectories (1 per problem)
│   ├── django__django-11039.md
│   ├── matplotlib__matplotlib-23299.md
│   └── ...
└── logs/               # Execution logs (1 dir per problem)
    ├── django__django-11039/
    │   ├── patch.diff
    │   ├── report.json
    │   └── test_output.txt
    └── ...
```

## Acknowledgments

- Built for the [Claude Code](https://claude.ai) ecosystem
- Powered by Anthropic's Claude Opus 4.5 model
- Inspired by multi-agent collaboration patterns

## Contact

- GitHub: [@asklokesh](https://github.com/asklokesh)
