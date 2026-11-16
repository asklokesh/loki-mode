# S1b no-loss signature (tests/min/scope-and-fix.sh and decompose-and-intake.sh): sig.py <run dir> <repo dir> prints the stage order, the receipt key set,
# the implement record key set and a hash of the implement brief with the repo path, run id and temp paths masked. Plan and Wall start at the same
# time, so their order is printed as the set {plan,wall}. The legs compare it with the line the same leg printed on the base commit.
import hashlib, json, re, sys
run, repo = sys.argv[1], sys.argv[2]
ev = [json.loads(l) for l in open(run + "/events.jsonl") if l.strip()]
stages = [e["stage"] for e in ev if e["type"] == "stage.started"]
order = ",".join(stages).replace("plan,wall", "{plan,wall}").replace("wall,plan", "{plan,wall}")
impl = next((e["data"] for e in ev if e["type"] == "stage.completed" and e["stage"] == "implement"), {})
rec = json.load(open(run + "/receipt.json"))
rid = run.rstrip("/").split("/")[-1]
brief = open(run + "/implement-brief.txt").read().replace(repo, "<repo>").replace(rid, "<run>")
brief = re.sub(r"/[^\s'\"`]*loki-[a-z]+\.[A-Za-z0-9]+[^\s'\"`]*", "<tmp>", brief)
print("stages=" + order + "; receipt=" + ",".join(sorted(rec)) + "; implement=" + ",".join(sorted(impl)) + "; brief=" + hashlib.sha256(brief.encode()).hexdigest()[:16])
