#!/usr/bin/env bash
# Workspaces: goal-driven repo selection (autonomy/lib/workspace.py affected), inferred ordering,
# read-only checkouts for unselected repos, the selection recorded in integration.json, linked PR comments and the
# summary line, the infer refactor, the loki.yaml schema key, and the CLI. Offline: three throwaway git repos
# (acme/api, acme/web, acme/docs, plus acme/crm in the boundary case), a stub launcher and a fake gh on PATH.
# Python drives the workspace functions with cfg dicts, so no YAML parser is needed.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. goal_terms: drop the camel variant (words[0] + "".join(cap[1:]) in _variants): the terms, the selection and
#      the ordering assertions fail.
#   2. _term_regex: drop the trailing (?![a-z0-9]) lookahead: acme/crm is selected through customerIdentity.
#   3. select_affected: return the empty selection instead of the fallback: the "add dark mode" assertion fails.
#   4. select_affected: drop the issue owner inclusion: the issue-ref assertion fails.
#   5. compose: skip merging infer_edges: web starts concurrently with api (web-early) and the order assertion fails.
#   6. run_workspace: default `on` to True: the default-off run misses docs and gains a selection key.
#   7. run_workspace: do not pass extra_dirs: the integration command cannot see LOKI_WS_DIR_ACME_DOCS (failed).
#   8. workspace_comment.render: ignore links: the Linked PRs section is gone from every comment.
#   9. infer_edges: drop the manifest branch: the infer golden assertion fails.
#  10. schema: remove the affected key: the schema assertion fails.
#  11. main: the affected subcommand writes under base_dir (or exits 0 for an unknown workspace): the CLI assertion fails.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v git >/dev/null 2>&1 || { echo "workspace: git missing, skipped"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "workspace: python3 missing, skipped"; exit 0; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

R="$T/repos"
mk() { # name, then "path:content" pairs
    local n="$1"; shift
    mkdir -p "$R/$n"; git -C "$R/$n" init -q -b main
    local kv
    for kv in "$@"; do
        mkdir -p "$R/$n/$(dirname "${kv%%:*}")"
        printf '%s\n' "${kv#*:}" > "$R/$n/${kv%%:*}"
    done
    git -C "$R/$n" add -A && git -C "$R/$n" commit -q -m init
}
mk api 'package.json:{"name": "@acme/api", "version": "1.0.0"}' 'src/customer.ts:export const customerId = 1' 'src/identity.ts:export const customerIdentity = 2'
mk web 'package.json:{"name": "web", "dependencies": {"@acme/api": "^1.0.0"}}' 'src/view.ts:import { x } from "@acme/api"
const a = row.customer_id'
mk docs 'README.md:Nothing relevant here.'
mk crm 'src/id.ts:export const customerIdentity = 3'

# stub launcher: records start order; api finishes slowly; web notes whether api was done when it started
cat > "$T/launcher.sh" <<LEOF
#!/usr/bin/env bash
n="\$(basename "\$PWD")"
echo "start \$n" >> "$T/calls"
case "\$n" in
    *api) sleep 0.3; touch "$T/api.done" ;;
    *web) [ -f "$T/api.done" ] || echo "web-early" >> "$T/calls" ;;
esac
exit 0
LEOF
chmod +x "$T/launcher.sh"

# fake gh: issue view, pr list (GH_PRS=1; web is a draft), pr comment (copies the body file)
mkdir -p "$T/bin" "$T/comments"
cat > "$T/bin/gh" <<GEOF
#!/usr/bin/env bash
case "\$1 \$2" in
    "issue view")
        [ "\${GH_ISSUE_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
        echo '{"number":7,"title":"Rename customer id","body":"","labels":[]}' ;;
    "pr list")
        [ "\${GH_PRS:-0}" = 1 ] || exit 0
        repo=""; while [ \$# -gt 0 ]; do [ "\$1" = --repo ] && repo="\$2"; shift; done
        d=false; case "\$repo" in *web) d=true ;; esac
        echo "{\"number\":1,\"url\":\"https://github.com/\$repo/pull/1\",\"isDraft\":\$d}" ;;
    "pr comment")
        repo=""; f=""; while [ \$# -gt 0 ]; do [ "\$1" = --repo ] && repo="\$2"; [ "\$1" = --body-file ] && f="\$2"; shift; done
        cp "\$f" "$T/comments/\$(echo "\$repo" | tr / _).md" ;;
esac
exit 0
GEOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

export T ROOT
out="$(LOKI_WORKSPACE_VERIFY=/usr/bin/false LOKI_WORKSPACE_LAUNCHER="$T/launcher.sh" LOKI_WORKSPACE_COMMENT=1 \
    python3 -I - <<'PYEOF' 2>&1
import json, os, sys, io, contextlib
T, ROOT = os.environ["T"], os.environ["ROOT"]
sys.path.insert(0, os.path.join(ROOT, "autonomy", "lib"))
import workspace

R = os.path.join(T, "repos")
def repo(n): return {"repo": "acme/" + n, "path": os.path.join(R, n)}
def cfg(names, **extra):
    d = {"repos": [repo(n) for n in names]}
    d.update(extra)
    return {"workspaces": {"shop": d}}
def chk(desc, cond, detail=""):
    print(("PASS: " if cond else "FAIL: ") + desc + ("" if cond else " (%s)" % (detail,)))
def capture(fn, *a, **k):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rv = fn(*a, **k)
    return rv, buf.getvalue()

G = "rename customer id everywhere"
t = workspace.goal_terms(G)
need = ["customer_id", "customerId", "CustomerId", "customer-id", "CUSTOMER_ID", "customerID", "customerid"]
chk("goal_terms yields the customer id variants and no single word", all(x in t for x in need) and "customer" not in t, t)
chk("goal_terms ignores a goal of plain single words", workspace.goal_terms("add dark mode") == [] or "dark" not in workspace.goal_terms("add dark mode"), workspace.goal_terms("add dark mode"))
chk("goal_terms takes explicit identifiers verbatim", "fooBar" in workspace.goal_terms("use fooBar here") and "tax_rate" in workspace.goal_terms("fix tax_rate"))
chk("goal_terms is capped", len(workspace.goal_terms(" ".join("alpha%dx beta%dy gamma%dz" % (i, i, i) for i in range(30)))) <= 40)

ws, _ = workspace.load_workspaces(cfg(["api", "web", "docs"]))
w = ws["shop"]
s = workspace.select_affected(w, G)
chk("select_affected picks api and web, not docs", s["selected"] == ["acme/api", "acme/web"] and "acme/docs" in s["not_selected"] and s["not_selected"]["acme/docs"] == "no match", s)
chk("api evidence starts at src/customer.ts:1", s["evidence"].get("acme/api", "").startswith("src/customer.ts:1"), s["evidence"])
rc, js = capture(workspace.affected, "shop", ws, G, as_json=True)
j = json.loads(js)
truth = {"acme/api", "acme/web"}
sel = set(j["selected"])
chk("affected --json recall 1.0 precision 1.0 with an order key", rc == 0 and len(sel & truth) / len(truth) == 1.0 and len(sel & truth) / len(sel) == 1.0 and j["order"] == ["acme/api", "acme/web"], j)
print("INFO: recall=%.1f precision=%.1f" % (len(sel & truth) / len(truth), len(sel & truth) / len(sel)))
rc, txt = capture(workspace.affected, "shop", ws, G)
chk("affected prints rows and the order line", rc == 0 and "acme/docs" in txt and "not selected (no match)" in txt and "order: acme/api -> acme/web" in txt, txt)

ws4, _ = workspace.load_workspaces(cfg(["api", "web", "docs", "crm"]))
s4 = workspace.select_affected(ws4["shop"], G)
chk("customerIdentity does not match customerId (boundary)", "acme/crm" not in s4["selected"], s4)

s5 = workspace.select_affected(w, "add dark mode")
chk("no match falls back to every repo", s5["selected"] == ["acme/api", "acme/web", "acme/docs"] and s5["fallback"] == "no repo matched the goal; running every repo", s5)

s6 = workspace.select_affected(w, "acme/docs#7")
chk("issue-ref goal selects the owner plus the repos the issue text hits", s6["selected"] == ["acme/api", "acme/web", "acme/docs"] and s6["evidence"]["acme/docs"] == "issue owner", s6)
os.environ["GH_ISSUE_FAIL"] = "1"
s7, o7 = capture(workspace.select_affected, w, "acme/docs#7")
chk("issue fetch failure still selects the owner and says so", "acme/docs" in s7["selected"] and "issue text unavailable" in o7, o7)
del os.environ["GH_ISSUE_FAIL"]

ws8, _ = workspace.load_workspaces(cfg(["api", "web"]))
ws8["shop"]["repos"].append({"repo": "acme/ghost", "path": os.path.join(T, "nope")})
s8 = workspace.select_affected(ws8["shop"], G)
chk("a repo with no checkout is included unscanned", s8["selected"] == ["acme/api", "acme/web", "acme/ghost"] and "unscanned" in s8["evidence"]["acme/ghost"], s8)

# golden: infer output unchanged by the refactor
rc, inf = capture(workspace.infer, "shop", ws)
chk("infer prints web after api with manifest evidence", rc == 0 and "acme/web" in inf and "acme/api" in inf and "manifest dependency" in inf, inf)
print("INFER_BEGIN\n" + inf + "INFER_END")

base = os.path.join(T, "base")
def calls():
    try: return open(os.path.join(T, "calls")).read().split("\n")
    except OSError: return []
def reset():
    for f in ("calls", "api.done"):
        try: os.unlink(os.path.join(T, f))
        except OSError: pass
def ev_of(path): return json.load(open(path))

os.environ["LOKI_WORKSPACE_AFFECTED"] = "1"
reset()
(rc, evp), out = capture(workspace.run_workspace, "shop", G, ws, base_dir=base)
c = calls()
ev = ev_of(evp)
chk("affected run starts api before web, no docs, no web-early", "start acme__api" in c and "start acme__web" in c and c.index("start acme__api") < c.index("start acme__web") and "web-early" not in c and not any("docs" in x for x in c), (c, out))
chk("integration.json records the selection", ev.get("selection", {}).get("selected") == ["acme/api", "acme/web"], ev.get("selection"))
del os.environ["LOKI_WORKSPACE_AFFECTED"]

reset()
(rc, evp), out = capture(workspace.run_workspace, "shop", G, ws, base_dir=base)
c = calls()
chk("default off: every repo starts and no selection key", any("docs" in x for x in c) and "selection" not in ev_of(evp), c)

# integration sees unselected repos read-only
wsi, _ = workspace.load_workspaces(cfg(["api", "web", "docs"], integration={"command": 'test -d "$LOKI_WS_DIR_ACME_DOCS"', "timeout_s": 30}))
reset()
(rc, evp), out = capture(workspace.run_workspace, "shop", G, wsi, base_dir=base, affected=True)
chk("integration sees LOKI_WS_DIR for an unselected repo", ev_of(evp).get("status") == "passed", ev_of(evp))

# linked PRs
os.environ["GH_PRS"] = "1"
reset()
wsp, _ = workspace.load_workspaces(cfg(["api", "web", "docs"]))
(rc, evp), out = capture(workspace.run_workspace, "shop", G, wsp, base_dir=base, affected=True)
cm = {}
for n in ("acme_api", "acme_web"):
    try: cm[n] = open(os.path.join(T, "comments", n + ".md")).read()
    except OSError: cm[n] = ""
both = all("Linked PRs:" in v and "https://github.com/acme/api/pull/1" in v and "https://github.com/acme/web/pull/1" in v for v in cm.values())
chk("each comment links both sibling PRs", both, cm)
def line_of(body, r):
    return next((l for l in body.split("\n") if l.startswith("- " + r + ": ")), "")
chk("this PR marker sits on the commenting repo's own line", "(this PR)" in line_of(cm["acme_api"], "acme/api") and "(this PR)" not in line_of(cm["acme_api"], "acme/web"), cm["acme_api"])
chk("draft marker on web", "(draft)" in line_of(cm["acme_api"], "acme/web"), cm["acme_api"])
chk("summary line counts linked PRs", "linked PRs: 2 of 2 repos have an open PR (1 ready, 1 draft)" in out, out)
del os.environ["GH_PRS"]

# schema
import loki_yaml
sch = loki_yaml.load_schema()
chk("schema accepts affected: true", not loki_yaml.validate({"workspaces": {"shop": {"repos": [], "affected": True}}}, sch))
errs = loki_yaml.validate({"workspaces": {"shop": {"repos": [], "afected": True}}}, sch)
chk("schema rejects a misspelled key and names it", errs and "afected" in str(errs), errs)

# CLI
workspace.load_workspaces = lambda cfg_=None: (ws, [])
cwd = os.path.join(T, "cliwd"); os.makedirs(cwd); os.chdir(cwd)
rc, js = capture(workspace.main, ["affected", "shop", "--json", G])
chk("CLI affected --json exits 0 with an order key and writes no files", rc == 0 and "order" in json.loads(js) and os.listdir(cwd) == [], (rc, js, os.listdir(cwd)))
rc, _ = capture(workspace.main, ["affected", "nope", "x"])
chk("CLI affected on an unknown workspace exits 2", rc == 2, rc)
rc, _ = capture(workspace.main, ["run", "shop"])
chk("CLI run without a goal exits 2", rc == 2, rc)
seen = {}
_orig_run = workspace.run_workspace
workspace.run_workspace = lambda name, ref, wss, **kw: (seen.update(kw, ref=ref) or (0, None))
capture(workspace.main, ["run", "shop", "--affected", "x"])
workspace.run_workspace = _orig_run
chk("run has no --affected flag (selection is yaml or env only)", seen.get("affected") is None and seen.get("ref") == "--affected x", seen)
PYEOF
)"
while IFS= read -r l; do
    case "$l" in
        "PASS: "*) ok "${l#PASS: }" ;;
        "FAIL: "*) bad "${l#FAIL: }" ;;
        INFO:*) printf '  %s\n' "$l" ;;
        Traceback*|*Error*) bad "python: $l" ;;
    esac
done <<< "$out"
golden="$(printf '%s\n' "$out" | sed -n '/^INFER_BEGIN$/,/^INFER_END$/p' | sed '1d;$d')"
want='workspace shop: suggested edges (print-only; copy into loki.yaml)
acme/api
  after: []
acme/web
  after: [acme/api]
    acme/api: manifest dependency
acme/docs
  after: []'
[ "$golden" = "$want" ] && ok "infer output is byte-identical to origin/main (golden)" || bad "infer golden differs: $golden"
finish
