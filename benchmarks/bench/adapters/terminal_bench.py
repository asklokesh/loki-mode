#!/usr/bin/env python3
"""Terminal-Bench (harbor-style) agent adapter for `loki start`.

Harbor drives an agent as: name(), version(), run(instruction, workdir). This
adapter wraps the existing loki adapter (adapters/loki.py) so a Terminal-Bench
trial runs `loki start` and yields ONE trial record: agent, version, model,
cost, tokens, duration, exit status, trial index and the task/dataset pin. Like
every adapter it never reports success: Terminal-Bench's own verifier decides.

Spend safety: LokiHarborAgent.run() refuses to execute without an injected
runner (a stub provider) unless LOKI_BENCH_SPEND_APPROVED=1. Importing this
module spawns nothing.
"""

import json
import os

try:
    from . import loki
except ImportError:  # loose-script import
    import loki  # type: ignore

RECORD_SCHEMA = "loki.terminal_bench.trial/1"
# Dataset pin as printed on the Terminal-Bench run page (see methodology-template.md).
DEFAULT_DATASET = "terminal-bench/terminal-bench@4.0.0"
DEFAULT_TRIALS = 5
DEFAULT_PER_TRIAL_CAP_USD = 10.0
RECORD_KEYS = (
    "schema", "benchmark", "dataset", "task_id", "trial", "agent",
    "agent_version", "model", "cost_usd", "tokens_in", "tokens_out",
    "duration_s", "exit_status", "cost_cap_usd", "cap_exceeded",
)


class SpendNotApproved(RuntimeError):
    """Raised when a non-stub (paid) run is requested without approval."""


class LokiHarborAgent:
    """Harbor-style agent: one instance per (model, provider)."""

    def __init__(self, model="sonnet", provider="claude",
                 dataset=DEFAULT_DATASET, cost_cap_usd=DEFAULT_PER_TRIAL_CAP_USD,
                 runner=None):
        self.model = model
        self.provider = provider
        self.dataset = dataset
        self.cost_cap_usd = float(cost_cap_usd)
        self.runner = runner

    @staticmethod
    def name():
        return "loki"

    def version(self):
        return loki._detect_loki_version(runner=self.runner)

    def run(self, instruction, workdir, *, task_id, trial=1, timeout=900):
        """Run one trial; return the trial record dict."""
        if self.runner is None and os.environ.get("LOKI_BENCH_SPEND_APPROVED") != "1":
            raise SpendNotApproved(
                "paid Terminal-Bench trial requires LOKI_BENCH_SPEND_APPROVED=1; "
                "inject a stub runner for a dry run")
        with open(os.path.join(workdir, "TASK.md"), "w") as fh:
            fh.write(instruction)
        out = loki.run(workdir, "TASK.md", model=self.model, timeout=timeout,
                       runner=self.runner, provider=self.provider)
        return make_record(out, dataset=self.dataset, task_id=task_id,
                           trial=trial, cost_cap_usd=self.cost_cap_usd)


def make_record(adapter_out, *, dataset, task_id, trial, cost_cap_usd):
    cost = adapter_out.get("cost_usd")
    return {
        "schema": RECORD_SCHEMA,
        "benchmark": "terminal-bench",
        "dataset": dataset,
        "task_id": str(task_id),
        "trial": int(trial),
        "agent": adapter_out.get("tool"),
        "agent_version": (loki.parse_loki_version(adapter_out.get("tool_version"))
                          or adapter_out.get("tool_version")),
        "model": adapter_out.get("model_used"),
        "cost_usd": cost,  # None means not recorded, never 0
        "tokens_in": adapter_out.get("tokens_in"),
        "tokens_out": adapter_out.get("tokens_out"),
        "duration_s": adapter_out.get("duration_s"),
        "exit_status": adapter_out.get("exit_status"),
        "cost_cap_usd": float(cost_cap_usd),
        "cap_exceeded": bool(cost is not None and cost > cost_cap_usd),
    }


def run_trials(agent, tasks, trials, workroot, out_path):
    """Run `trials` trials per task ({id, instruction}); append JSONL records."""
    records = []
    with open(out_path, "a") as fh:
        for task in tasks:
            for t in range(1, trials + 1):
                wd = os.path.join(workroot, "%s-t%d" % (task["id"], t))
                os.makedirs(wd, exist_ok=True)
                rec = agent.run(task["instruction"], wd, task_id=task["id"], trial=t)
                fh.write(json.dumps(rec, sort_keys=True) + "\n")
                records.append(rec)
    return records


def forecast(n_tasks, trials=DEFAULT_TRIALS, expected_usd=None,
             cap_usd=DEFAULT_PER_TRIAL_CAP_USD):
    """Spend forecast in USD. ceiling = n * cap is a hard bound; expected is
    only given when the caller supplies a per-trial estimate (an assumption)."""
    n = int(n_tasks) * int(trials)
    out = {"n_tasks": int(n_tasks), "trials_per_task": int(trials),
           "n_trials": n, "per_trial_cap_usd": float(cap_usd),
           "ceiling_usd": round(n * float(cap_usd), 2),
           "expected_per_trial_usd": expected_usd, "expected_usd": None}
    if expected_usd is not None:
        out["expected_usd"] = round(n * float(expected_usd), 2)
    return out
