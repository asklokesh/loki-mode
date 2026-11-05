"""Post the workspace integration result as one PR comment per repo PR (D51-B11).

No LLM. Uses the `gh` CLI with the caller's own environment, so GH_TOKEN or
GITHUB_TOKEN is read by gh itself and never placed in argv, the comment body
or any log line. Commenting is best effort: it never raises and never changes
the run's exit code. Opt out with LOKI_WORKSPACE_COMMENT=0.
"""
import json
import os
import subprocess
import tempfile

GH_TIMEOUT_S = 60


def verdict(ev):
    """Map integration evidence to a label. Only a clean exit 0 reads as PASSED."""
    status = ev.get("status")
    if "timeout" in str(ev.get("note") or "").lower():
        return "TIMEOUT"
    if status == "passed" and ev.get("exit_code") == 0:
        return "PASSED"
    if status == "not_configured":
        return "NOT CONFIGURED"
    return "FAILED"


def render(ws_name, run_id, repo, ev, links=None):
    heads = ev.get("heads") or {}
    lines = ["Loki workspace `%s` run `%s`" % (ws_name, run_id), "",
             "Integration: **%s** (exit code %s)" % (verdict(ev), ev.get("exit_code")), "",
             "| Repo | Outcome | Head SHA |", "| --- | --- | --- |"]
    outcomes = ev.get("outcomes") or {}
    for r in sorted(heads.keys() | outcomes.keys()):
        out = outcomes.get(r, "unknown")
        out = "ok" if out == "ok" else str(out).replace("|", "/")
        mark = " (this PR)" if r == repo else ""
        lines.append("| %s%s | %s | %s |" % (r, mark, out, heads.get(r) or "none"))
    if ev.get("log_sha256"):
        lines += ["", "Integration log sha256: `%s`" % ev["log_sha256"]]
    if links is not None:
        lines += ["", "Linked PRs:"]
        for r in sorted(links.keys() | set(worktrees_of(ev))):
            pr = links.get(r)
            if pr:
                lines.append("- %s: %s%s%s" % (r, pr["url"], " (this PR)" if r == repo else "",
                                              " (draft)" if pr.get("draft") else ""))
            else:
                lines.append("- %s: no open PR" % r)
    lines += ["", "Integration evidence is not part of the Seal."]
    return "\n".join(lines) + "\n"


def _gh(args, cwd):
    return subprocess.run(["gh"] + args, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True,
                          text=True, timeout=GH_TIMEOUT_S)


def _branch(wt):
    r = subprocess.run(["git", "-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True,
                       timeout=GH_TIMEOUT_S)
    b = r.stdout.strip()
    return b if r.returncode == 0 and b and b != "HEAD" else None


def worktrees_of(ev):
    """Repos that ran: the ones with a recorded head SHA or outcome."""
    return list((ev.get("heads") or {}).keys() | (ev.get("outcomes") or {}).keys())


def find_prs(worktrees):
    """{repo: {number, url, draft}} for each repo with an open PR on its run branch. Never raises."""
    found = {}
    for repo, wt in sorted(worktrees.items()):
        try:
            branch = _branch(wt)
            if not branch:
                continue
            r = _gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open",
                     "--json", "number,url,isDraft", "--jq", ".[0]"], wt)
            d = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None
            if isinstance(d, dict) and isinstance(d.get("number"), int) and isinstance(d.get("url"), str):
                found[repo] = {"number": d["number"], "url": d["url"], "draft": bool(d.get("isDraft"))}
        except (OSError, subprocess.SubprocessError, ValueError):
            continue
    return found


def post_comments(ws_name, run_id, run_dir, worktrees, ev, say, links=None):
    """One comment per repo that has an open PR on its run branch. Never raises."""
    if os.environ.get("LOKI_WORKSPACE_COMMENT") == "0":
        return 0
    posted = 0
    try:
        if links is None:
            links = find_prs(worktrees)
        for repo, wt in sorted(worktrees.items()):
            try:
                if repo not in links:
                    continue
                num = str(links[repo]["number"])
                fd, body = tempfile.mkstemp(prefix="comment-", suffix=".md", dir=run_dir)  # mode 0600
                try:
                    with os.fdopen(fd, "w") as f:
                        f.write(render(ws_name, run_id, repo, ev, links))
                    c = _gh(["pr", "comment", num, "--repo", repo, "--body-file", body], wt)
                finally:
                    try:
                        os.unlink(body)
                    except OSError:
                        pass
                if c.returncode == 0:
                    posted += 1
                else:
                    say("workspace: comment on %s#%s failed (gh exit %d)" % (repo, num, c.returncode))
            except (OSError, subprocess.SubprocessError, ValueError) as e:
                say("workspace: comment for %s skipped (%s)" % (repo, type(e).__name__))
    except Exception as e:  # never fail the run because commenting failed
        say("workspace: commenting skipped (%s)" % type(e).__name__)
    return posted
