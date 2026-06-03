"""R2 benchmark competitor adapters.

Each adapter runs ONE tool on a spec in a workdir and reports only what the
tool did: tool, tool_version, model_used, duration_s, iterations, tokens,
cost_usd|null, exit_status, provenance. Adapters NEVER report success or
quality. The read-only grader (owned by the runner agent) decides success
on a host outside the agent container. This boundary is the credibility
anchor of the whole harness: a vendor that grades its own runs is dismissed.
"""
