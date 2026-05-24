"""X-79: Prometheus-format forge metrics.

Renders the live counters from each service as text/plain in the
Prometheus exposition format. No external dependency.
"""

from __future__ import annotations

import os
from typing import List


def render(forge_dir: str) -> str:
    """Return the Prometheus exposition text for the current forge state."""
    if not os.path.isdir(forge_dir):
        return "# forge state directory not present\n"
    lines: List[str] = []
    # Tables.
    try:
        from forge.services.database import open_engine, introspect
        if os.path.exists(os.path.join(forge_dir, "db.sqlite")):
            snap = introspect(open_engine(forge_dir))
            lines.append("# HELP forge_tables_total Number of tables")
            lines.append("# TYPE forge_tables_total gauge")
            lines.append(f"forge_tables_total {len(snap.get('tables', []))}")
            lines.append("# HELP forge_rows_estimate Estimated row count per table")
            lines.append("# TYPE forge_rows_estimate gauge")
            for t in snap.get("tables", []):
                lines.append(
                    f'forge_rows_estimate{{table="{t["name"]}"}} '
                    f'{int(t.get("row_count_estimate", 0))}'
                )
    except Exception:
        pass
    # Buckets.
    try:
        from forge.services.storage import list_buckets, list_objects
        buckets = list_buckets(forge_dir)
        lines.append("# HELP forge_buckets_total Number of buckets")
        lines.append("# TYPE forge_buckets_total gauge")
        lines.append(f"forge_buckets_total {len(buckets)}")
        lines.append("# HELP forge_bucket_objects_total Object count per bucket")
        lines.append("# TYPE forge_bucket_objects_total gauge")
        lines.append("# HELP forge_bucket_bytes_total Byte total per bucket")
        lines.append("# TYPE forge_bucket_bytes_total gauge")
        for b in buckets:
            objs = list_objects(forge_dir, b["name"], limit=10000)
            lines.append(
                f'forge_bucket_objects_total{{bucket="{b["name"]}"}} '
                f'{len(objs)}'
            )
            lines.append(
                f'forge_bucket_bytes_total{{bucket="{b["name"]}"}} '
                f'{sum(o.get("size", 0) for o in objs)}'
            )
    except Exception:
        pass
    # Functions.
    try:
        from forge.services.functions import list_functions, list_runs
        fns = list_functions(forge_dir)
        lines.append("# HELP forge_functions_total Number of functions")
        lines.append("# TYPE forge_functions_total gauge")
        lines.append(f"forge_functions_total {len(fns)}")
        lines.append("# HELP forge_function_invocations_total Run counter")
        lines.append("# TYPE forge_function_invocations_total counter")
        for fn in fns:
            runs = list_runs(forge_dir, fn["name"], limit=10000)
            lines.append(
                f'forge_function_invocations_total{{name="{fn["name"]}"}} '
                f'{len(runs)}'
            )
        # N-15: warm-pool effectiveness counter. Surfaced even when
        # warm_count is 0 so dashboards can graph the gauge across
        # all functions without a special-case for never-warmed ones.
        lines.append("# HELP forge_function_warm_total Successful warm() calls")
        lines.append("# TYPE forge_function_warm_total counter")
        for fn in fns:
            lines.append(
                f'forge_function_warm_total{{name="{fn["name"]}"}} '
                f'{int(fn.get("warm_count", 0))}'
            )
    except Exception:
        pass
    # Schedules.
    try:
        from forge.services.schedules import list_schedules, watchdog_status
        scheds = list_schedules(forge_dir)
        lines.append("# HELP forge_schedules_total Number of schedules")
        lines.append("# TYPE forge_schedules_total gauge")
        lines.append(f"forge_schedules_total {len(scheds)}")
        if scheds:
            w = watchdog_status(forge_dir)
            lines.append("# HELP forge_schedule_ticks_total Ticks since runner start")
            lines.append("# TYPE forge_schedule_ticks_total counter")
            lines.append(f'forge_schedule_ticks_total {w.get("ticks_total", 0)}')
            # N-26: per-schedule last_run_outcome distribution. Counters
            # by outcome so dashboards can graph the error rate without
            # walking the per-run JSON files.
            outcomes: dict = {}
            for s in scheds:
                key = (s.get("name", ""),
                       (s.get("last_run_outcome") or "none"))
                outcomes[key] = outcomes.get(key, 0) + 1
            if outcomes:
                lines.append(
                    "# HELP forge_schedule_last_outcome "
                    "Last run outcome per schedule (counter; 1 per row)"
                )
                lines.append(
                    "# TYPE forge_schedule_last_outcome gauge"
                )
                for (name, outcome), n in sorted(outcomes.items()):
                    lines.append(
                        f'forge_schedule_last_outcome{{name="{name}",'
                        f'outcome="{outcome}"}} {n}'
                    )
    except Exception:
        pass
    # Gateway.
    try:
        from forge.services.gateway import usage_summary
        usage = usage_summary(forge_dir)
        lines.append("# HELP forge_gateway_requests_total Gateway request counter")
        lines.append("# TYPE forge_gateway_requests_total counter")
        for (model, provider), v in usage.items():
            lines.append(
                f'forge_gateway_requests_total{{model="{model}",'
                f'provider="{provider}"}} {v.get("count", 0)}'
            )
        lines.append("# HELP forge_gateway_tokens_total Output tokens accumulator")
        lines.append("# TYPE forge_gateway_tokens_total counter")
        for (model, provider), v in usage.items():
            lines.append(
                f'forge_gateway_tokens_total{{model="{model}",'
                f'provider="{provider}"}} {v.get("output_tokens", 0)}'
            )
    except Exception:
        pass
    return "\n".join(lines) + "\n"
