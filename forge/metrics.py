"""X-79: Prometheus-format forge metrics.

Renders the live counters from each service as text/plain in the
Prometheus exposition format. No external dependency.
"""

from __future__ import annotations

import os
from typing import Dict, List


def _label_str(labels: dict) -> str:
    """Render `{a="b",c="d"}` or '' if no labels. Static-label augment."""
    if not labels:
        return ""
    return "{" + ",".join(f'{k}="{v}"' for k, v in sorted(labels.items())) + "}"


def _merge_labels(line: str, extra: dict) -> str:
    """Inject extra labels into an exposition line that may already have a
    `{}` block. Lines without metrics (HELP/TYPE/blank) pass through."""
    if not extra:
        return line
    s = line.lstrip()
    if not s or s.startswith("#"):
        return line
    if "{" in s:
        # Already has labels - insert before the closing brace.
        head, _, rest = line.partition("{")
        inner, _, tail = rest.partition("}")
        existing = inner.strip()
        new_inner = ",".join(
            [existing] +
            [f'{k}="{v}"' for k, v in sorted(extra.items())]
        ).strip(",")
        return f"{head}{{{new_inner}}}{tail}"
    # No labels yet - add a {} block before the value.
    name, sep, value = line.partition(" ")
    return f"{name}{_label_str(extra)}{sep}{value}"


def render(forge_dir: str, *, labels: dict = None) -> str:
    """Return the Prometheus exposition text for the current forge state.

    N-31: `labels` is a flat {key: value} dict whose pairs are appended
    to every metric line. Use for static dimensions (env, region, host)
    so a multi-environment scraper can disambiguate without renaming
    series.
    """
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
        # N-32: opt-out count so operators can see how many functions
        # disabled warm. Surfaced as a gauge (the count fluctuates as
        # manifests are flipped).
        warm_disabled_n = sum(1 for fn in fns
                              if fn.get("warm_disabled") is True)
        lines.append("# HELP forge_function_warm_disabled Functions with warm_disabled=True")
        lines.append("# TYPE forge_function_warm_disabled gauge")
        lines.append(f"forge_function_warm_disabled {warm_disabled_n}")
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
            # N-44: surface next_fire_ts per schedule so dashboards
            # can predict when load spikes will hit. Unix epoch
            # seconds; 0 when the schedule is parked.
            # N-103: include `tag` label per emitted tag so multi-
            # tenant dashboards can group.
            lines.append(
                "# HELP forge_schedule_next_fire_ts "
                "Unix epoch seconds of next scheduled fire"
            )
            lines.append(
                "# TYPE forge_schedule_next_fire_ts gauge"
            )
            for s in scheds:
                tags = s.get("tags") or [""]
                for tag in tags:
                    tag_label = f',tag="{tag}"' if tag else ""
                    lines.append(
                        f'forge_schedule_next_fire_ts{{name="{s.get("name", "")}"'
                        f'{tag_label}}} {int(s.get("next_fire_ts") or 0)}'
                    )
    except Exception:
        pass
    # Secrets (N-55, N-63).
    try:
        from forge.services.secrets.vault import list_secrets, weak_secrets
        rows = list_secrets(forge_dir)
        weak = weak_secrets(forge_dir)
        lines.append("# HELP forge_secrets_total Total secrets in the vault")
        lines.append("# TYPE forge_secrets_total gauge")
        lines.append(f"forge_secrets_total {len(rows)}")
        lines.append("# HELP forge_secrets_weak Secrets on HMAC-XOR fallback")
        lines.append("# TYPE forge_secrets_weak gauge")
        lines.append(f"forge_secrets_weak {len(weak)}")
        # N-63: stale buckets so dashboards see rotation candidates.
        stale_30 = sum(1 for r in rows
                       if isinstance(r.get("unused_for_days"), int)
                       and r["unused_for_days"] > 30)
        stale_90 = sum(1 for r in rows
                       if isinstance(r.get("unused_for_days"), int)
                       and r["unused_for_days"] > 90)
        lines.append("# HELP forge_secrets_stale Secrets unused longer than the bucket")
        lines.append("# TYPE forge_secrets_stale gauge")
        lines.append(f'forge_secrets_stale{{bucket="30d"}} {stale_30}')
        lines.append(f'forge_secrets_stale{{bucket="90d"}} {stale_90}')
    except Exception:
        pass
    # Email templates (N-72, N-80).
    try:
        from forge.services.email import list_templates
        rows = list_templates(forge_dir)
        defaults = sum(1 for r in rows if "@" not in r.get("name", ""))
        variants = sum(1 for r in rows if "@" in r.get("name", ""))
        lines.append("# HELP forge_email_templates_total Default templates")
        lines.append("# TYPE forge_email_templates_total gauge")
        lines.append(f"forge_email_templates_total {defaults}")
        lines.append("# HELP forge_email_template_locales Locale variants")
        lines.append("# TYPE forge_email_template_locales gauge")
        lines.append(f"forge_email_template_locales {variants}")
        # N-80: per-name locale coverage gauge so dashboards see which
        # templates have how many variants.
        per_name: Dict[str, int] = {}
        for r in rows:
            name = r.get("name", "")
            base = name.split("@", 1)[0]
            per_name[base] = per_name.get(base, 0) + 1
        if per_name:
            lines.append("# HELP forge_email_template_coverage Default + variants per template name")
            lines.append("# TYPE forge_email_template_coverage gauge")
            for base, n in sorted(per_name.items()):
                lines.append(
                    f'forge_email_template_coverage{{name="{base}"}} {n}'
                )
            # N-95: bucket distribution so dashboards graph coverage
            # without iterating per name. Buckets: 1, 2-5, 6-10, >10.
            b1 = sum(1 for n in per_name.values() if n == 1)
            b5 = sum(1 for n in per_name.values() if 2 <= n <= 5)
            b10 = sum(1 for n in per_name.values() if 6 <= n <= 10)
            bx = sum(1 for n in per_name.values() if n > 10)
            lines.append("# HELP forge_email_locales_bucket Template count by locale coverage bucket")
            lines.append("# TYPE forge_email_locales_bucket gauge")
            lines.append(f'forge_email_locales_bucket{{bucket="1"}} {b1}')
            lines.append(f'forge_email_locales_bucket{{bucket="2-5"}} {b5}')
            lines.append(f'forge_email_locales_bucket{{bucket="6-10"}} {b10}')
            lines.append(f'forge_email_locales_bucket{{bucket=">10"}} {bx}')
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
    if labels:
        lines = [_merge_labels(ln, labels) for ln in lines]
    return "\n".join(lines) + "\n"
