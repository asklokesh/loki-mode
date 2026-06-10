#!/usr/bin/env python3
"""SWE-bench Pro evaluator column/type shim (REQUIRED before grading).

The bundled dataset (helper_code/sweap_eval_full_v2.jsonl) stores test-list
columns as UPPERCASE keys (FAIL_TO_PASS / PASS_TO_PASS) and is inconsistently
typed: some list fields are already repr-STRINGS (e.g. "['TestSpotify']") while
others are native JSON lists. The official swe_bench_pro_eval.py reads LOWERCASE
keys (fail_to_pass / pass_to_pass) and eval()s each list-ish field. Feeding the
raw jsonl KeyErrors on case; naively re-repr()-ing a string splits it into
characters (this produced a mangled Go -run regex / false negative in dry-run 1).

This shim coerces the bundled jsonl into exactly what the evaluator expects:
lowercase keys, and every list field as a repr-STRING (native lists get repr()-d,
existing strings pass through unchanged).

Verified in the runbook dry-run: gold patch -> True, empty patch -> False on
the navidrome control instance.
"""

import json


def as_repr_string(v):
    """Native list -> repr-string. Existing string -> unchanged."""
    return v if isinstance(v, str) else repr(list(v))


def build_eval_jsonl(src_jsonl, instance_ids, out_jsonl):
    """Write an evaluator-ready jsonl containing exactly `instance_ids`.

    Args:
      src_jsonl: path to helper_code/sweap_eval_full_v2.jsonl (731 rows).
      instance_ids: iterable of instance_id strings to include, in order.
      out_jsonl: output path for the coerced jsonl.
    """
    rows = {}
    with open(src_jsonl) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            rows[rec["instance_id"]] = rec
    with open(out_jsonl, "w") as f:
        for iid in instance_ids:
            r = rows[iid]
            f.write(json.dumps({
                "instance_id": r["instance_id"],
                "repo": r["repo"],
                "base_commit": r["base_commit"],
                "before_repo_set_cmd": r["before_repo_set_cmd"],
                "selected_test_files_to_run":
                    as_repr_string(r["selected_test_files_to_run"]),
                "fail_to_pass": as_repr_string(r["FAIL_TO_PASS"]),
                "pass_to_pass": as_repr_string(r["PASS_TO_PASS"]),
            }) + "\n")


if __name__ == "__main__":
    import sys
    # Usage: eval_shim.py <src_jsonl> <out_jsonl> <id1> [id2 ...]
    src, out, ids = sys.argv[1], sys.argv[2], sys.argv[3:]
    build_eval_jsonl(src, ids, out)
    print(f"wrote {len(ids)} rows to {out}")
