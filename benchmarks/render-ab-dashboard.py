#!/usr/bin/env python3
"""Render benchmarks/results/ab-history.jsonl into a plain-language HTML dashboard.

Reads the append-only trial history and produces:
  benchmarks/results/ab-dashboard.html

Design constraints that matter more than the styling:

  * Medians, not means. Iteration counts are small integers with occasional
    cap-hits; one run pinned at the cap drags a mean and misleads.
  * The spread is always shown. A median gap smaller than the observed spread
    is NOT a result, and the verdict says so in plain words.
  * A run that produced no metrics file is rendered as a visible MISSING cell,
    never silently dropped -- a lost cell must not read as "did not happen".
  * No claim is made about output QUALITY. The acceptance check here is a
    file-existence assertion; the honest scope is "iterations and time to a
    completing run".

Safe to re-run at any time; it only reads the history file.
"""

import json
import os
import statistics
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY = os.path.join(HERE, "results", "ab-history.jsonl")
OUT = os.path.join(HERE, "results", "ab-dashboard.html")


def load():
    rows = []
    if not os.path.exists(HISTORY):
        return rows
    with open(HISTORY) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # A partially-written final line (runner killed mid-append)
                # must not blank the whole dashboard.
                continue
    return rows


def num(row, key):
    v = row.get(key)
    return v if isinstance(v, (int, float)) else None


def summarize(rows, arm):
    # An "arm" is a family: the post-fix engine is recorded under several labels
    # (v8-fixed, v8-final) as the fix was tightened. They are the SAME engine
    # generation for comparison purposes, so match on prefix rather than an exact
    # string -- otherwise later trials silently vanish from the verdict.
    def _in(r):
        a = r.get("arm") or ""
        return a == arm or a.startswith(arm + "-")
    got = [r for r in rows if _in(r) and not r.get("missing")]
    missing = len([r for r in rows if _in(r) and r.get("missing")])
    iters = [v for v in (num(r, "act_iterations") for r in got) if v is not None]
    walls = [v for v in (num(r, "wall_clock_min") for r in got) if v is not None]
    if not walls:
        walls = [
            round(v / 60.0, 1)
            for v in (num(r, "wall_clock_s") for r in got)
            if v is not None
        ]
    completed = [bool(r.get("engine_completed")) for r in got]
    accepted = []
    for r in got:
        a = r.get("acceptance")
        accepted.append(bool(a) and all(bool(x) for x in a.values()) if isinstance(a, dict) else False)
    return {
        "arm": arm,
        "n": len(got),
        "missing": missing,
        "iters": iters,
        "walls": walls,
        "med_iters": statistics.median(iters) if iters else None,
        "med_wall": statistics.median(walls) if walls else None,
        "completed": sum(completed),
        "accepted": sum(accepted),
    }


def spread(vals):
    return (max(vals) - min(vals)) if len(vals) >= 2 else 0


def verdict(v8, v7):
    """Plain-language verdict. Refuses to call a gap that the noise can explain."""
    if v8["n"] < 2 or v7["n"] < 2:
        return ("more-data", "Not enough trials yet",
                f"{v8['n']} v8 and {v7['n']} v7 trials so far. At least 3 of each are "
                "needed before any comparison means anything.")
    a, b = v8["med_iters"], v7["med_iters"]
    if a is None or b is None:
        return ("more-data", "No iteration data", "Trials did not record iteration counts.")
    gap = b - a
    noise = max(spread(v8["iters"]), spread(v7["iters"]))
    if abs(gap) <= noise:
        return ("tie", "Too close to call",
                f"v8 typically takes {a:g} rounds, v7 takes {b:g}. That difference "
                f"({abs(gap):g}) is no bigger than the natural run-to-run variation "
                f"({noise:g}), so it is not a real difference. More trials would sharpen this.")
    if gap > 0:
        pct = round(gap / b * 100)
        # Wall clock is a SEPARATE, weaker claim than round count. Model latency
        # dominates a short run and is noisy, so the time ranges can overlap even
        # when the round counts do not. Say so instead of implying both are
        # equally established.
        note = ""
        if v8["walls"] and v7["walls"] and min(v7["walls"]) < max(v8["walls"]):
            note = (f" Time per run is less clear-cut: the slowest new run "
                    f"({max(v8['walls']):g} min) is not faster than the quickest old one "
                    f"({min(v7['walls']):g} min), so treat the time saving as likely "
                    "rather than proven. The round count is the reliable number, and "
                    "it is also what the cost tracks.")
        return ("win", f"v8 finishes in fewer rounds ({pct}% fewer)",
                f"v8 typically needs {a:g} rounds where v7 needs {b:g}. The gap ({gap:g}) "
                f"is larger than the run-to-run variation ({noise:g}), so it looks real. "
                "Fewer rounds means less time and lower cost for the same job." + note)
    pct = round(-gap / b * 100)
    return ("regress", f"v8 takes MORE rounds ({pct}% more)",
            f"v8 typically needs {a:g} rounds where v7 needs {b:g}. This is a regression "
            "and needs investigating before it reaches users.")


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def render(rows):
    v8, v7 = summarize(rows, "v8"), summarize(rows, "v7")
    kind, headline, detail = verdict(v8, v7)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    def cards():
        out = []
        for s, name in ((v8, "v8.0.0 (new)"), (v7, "v7.129.5 (previous)")):
            mi = f"{s['med_iters']:g}" if s["med_iters"] is not None else "--"
            mw = f"{s['med_wall']:g}" if s["med_wall"] is not None else "--"
            runs = ", ".join(f"{i:g}" for i in s["iters"]) or "none yet"
            out.append(f"""
      <div class="card">
        <h3>{esc(name)}</h3>
        <div class="big">{mi}<span class="unit">rounds</span></div>
        <div class="sub">typical (median) of {s['n']} trial(s)</div>
        <dl>
          <dt>Typical time</dt><dd>{mw} min</dd>
          <dt>Each run took</dt><dd>{esc(runs)} rounds</dd>
          <dt>Finished cleanly</dt><dd>{s['completed']} of {s['n']}</dd>
          <dt>Output check passed</dt><dd>{s['accepted']} of {s['n']}</dd>
          <dt>Lost runs</dt><dd>{s['missing']}</dd>
        </dl>
      </div>""")
        return "".join(out)

    trs = []
    for r in sorted(rows, key=lambda x: x.get("recorded_at", "")):
        if r.get("missing"):
            trs.append(
                f'<tr class="missing"><td>{esc(r.get("recorded_at",""))}</td>'
                f'<td>{esc(r.get("arm",""))}</td><td>{esc(r.get("label",""))}</td>'
                f'<td colspan="4">no result recorded (run did not finish)</td></tr>')
            continue
        acc = r.get("acceptance")
        ok = bool(acc) and all(bool(x) for x in acc.values()) if isinstance(acc, dict) else False
        w = num(r, "wall_clock_min")
        if w is None:
            ws = num(r, "wall_clock_s")
            w = round(ws / 60.0, 1) if ws is not None else None
        trs.append(
            f'<tr><td>{esc(r.get("recorded_at",""))}</td><td>{esc(r.get("arm",""))}</td>'
            f'<td>{esc(r.get("label",""))}</td><td class="n">{esc(r.get("act_iterations","--"))}</td>'
            f'<td class="n">{esc(w if w is not None else "--")}</td>'
            f'<td>{"yes" if r.get("engine_completed") else "no"}</td>'
            f'<td>{"pass" if ok else "fail"}</td></tr>')
    if not trs:
        trs.append('<tr><td colspan="7">No trials recorded yet.</td></tr>')

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loki Mode: v8 vs v7 benchmark history</title>
<style>
  :root {{
    --bg:#fbfaf8; --fg:#1a1a19; --muted:#6b6a66; --line:#e2e0da;
    --card:#ffffff; --accent:#1f6f5c; --warn:#8a5a1c; --bad:#8f2f2f;
  }}
  @media (prefers-color-scheme:dark) {{
    :root {{ --bg:#15161a; --fg:#e9e8e4; --muted:#9b9a95; --line:#2c2e34;
             --card:#1c1e23; --accent:#5fbfa3; --warn:#d6a05a; --bad:#e08585; }}
  }}
  :root[data-theme="dark"] {{ --bg:#15161a; --fg:#e9e8e4; --muted:#9b9a95;
    --line:#2c2e34; --card:#1c1e23; --accent:#5fbfa3; --warn:#d6a05a; --bad:#e08585; }}
  :root[data-theme="light"] {{ --bg:#fbfaf8; --fg:#1a1a19; --muted:#6b6a66;
    --line:#e2e0da; --card:#ffffff; --accent:#1f6f5c; --warn:#8a5a1c; --bad:#8f2f2f; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--fg); font:16px/1.6
    ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; }}
  .wrap {{ max-width:960px; margin:0 auto; padding:40px 20px 72px; }}
  h1 {{ font-size:28px; margin:0 0 4px; letter-spacing:-.01em; }}
  .stamp {{ color:var(--muted); font-size:14px; margin-bottom:32px; }}
  .verdict {{ border:1px solid var(--line); border-left:4px solid var(--accent);
    background:var(--card); padding:20px 24px; border-radius:10px; margin-bottom:28px; }}
  .verdict.tie {{ border-left-color:var(--warn); }}
  .verdict.more-data {{ border-left-color:var(--muted); }}
  .verdict.regress {{ border-left-color:var(--bad); }}
  .verdict h2 {{ font-size:20px; margin:0 0 8px; }}
  .verdict p {{ margin:0; color:var(--muted); }}
  .cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
    gap:16px; margin-bottom:32px; }}
  .card {{ background:var(--card); border:1px solid var(--line);
    border-radius:10px; padding:20px 22px; }}
  .card h3 {{ margin:0 0 12px; font-size:14px; text-transform:uppercase;
    letter-spacing:.06em; color:var(--muted); font-weight:600; }}
  .big {{ font-size:44px; font-weight:600; line-height:1;
    font-variant-numeric:tabular-nums; }}
  .unit {{ font-size:15px; font-weight:400; color:var(--muted); margin-left:8px; }}
  .sub {{ color:var(--muted); font-size:13px; margin:6px 0 16px; }}
  dl {{ display:grid; grid-template-columns:auto 1fr; gap:6px 16px;
    margin:0; font-size:14px; }}
  dt {{ color:var(--muted); }}
  dd {{ margin:0; text-align:right; font-variant-numeric:tabular-nums; }}
  .scroll {{ overflow-x:auto; }}
  table {{ border-collapse:collapse; width:100%; font-size:14px; min-width:620px; }}
  th,td {{ text-align:left; padding:9px 12px; border-bottom:1px solid var(--line);
    white-space:nowrap; }}
  th {{ color:var(--muted); font-weight:600; font-size:12px;
    text-transform:uppercase; letter-spacing:.05em; }}
  td.n {{ text-align:right; font-variant-numeric:tabular-nums; }}
  tr.missing td {{ color:var(--bad); }}
  h2.sec {{ font-size:16px; margin:36px 0 12px; }}
  .note {{ color:var(--muted); font-size:13.5px; border-top:1px solid var(--line);
    margin-top:36px; padding-top:20px; }}
  .note li {{ margin-bottom:7px; }}
</style></head><body><div class="wrap">

<h1>v8 vs v7: does the new engine finish faster?</h1>
<div class="stamp">Updated {now}. Same job, same AI model, same machine. Only the engine version differs.</div>

<div class="verdict {kind}">
  <h2>{esc(headline)}</h2>
  <p>{esc(detail)}</p>
</div>

<div class="cards">{cards()}</div>

<h2 class="sec">Every run recorded</h2>
<div class="scroll"><table>
  <thead><tr><th>When</th><th>Version</th><th>Run</th><th>Rounds</th>
    <th>Minutes</th><th>Finished</th><th>Check</th></tr></thead>
  <tbody>{''.join(trs)}</tbody>
</table></div>

<div class="note"><strong>How to read this</strong>
<ul>
  <li><strong>Rounds</strong> is how many attempts the engine needed before it
      considered the job done. Fewer rounds means less time and less money for
      the same result. This is the number that matters most.</li>
  <li>We report the <strong>typical</strong> (median) run, not the average, so a
      single unusual run cannot skew the picture.</li>
  <li>The AI is not perfectly repeatable, so the same job can take a different
      number of rounds each time. A difference smaller than that natural
      variation is not a real difference, and the verdict above says so when
      that happens.</li>
  <li><strong>Check</strong> is a basic did-it-produce-the-file test. It confirms
      the engine finished the job; it is not a judgment of how good the code is.</li>
</ul></div>

</div></body></html>
"""


def main():
    rows = load()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        fh.write(render(rows))
    print(f"wrote {OUT} ({len(rows)} trial rows)")


if __name__ == "__main__":
    main()
