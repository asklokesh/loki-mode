// loki-ts/src/util/dashboard_page.ts (moved from engine10/dashboard/page.ts to keep the core under its line cap, D29/D33)
//
// E-24: the dashboard's single HTML page (docs/v10/ENGINE.md section 12).
// Inlined as a string so `dist` bundles it with no separate asset step. All
// data comes from server.ts's JSON/SSE endpoints; this file has no server
// logic of its own.
export function renderPage(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Loki 10 dashboard</title>
<style>
  :root { --bg: #0b0b0c; --fg: #ddd; --muted: #888; --line: #222; --hover: #161616; --sel: #1c2b1c; --warn: #e8b339; --warn-line: #5a4a1a; --warn-bg: #2a220c; --ok: #5cb85c; --run: #4aa3df; --bad: #e5534b; --skip: #888; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --fg: #1d1d1f; --muted: #666; --line: #ddd; --hover: #eee; --sel: #dff0df; --warn: #7a5a00; --warn-line: #e0c36a; --warn-bg: #fff6dd; --ok: #2e7d32; --run: #1565c0; --bad: #c62828; --skip: #777; }
  }
  body { font: 13px/1.5 ui-monospace, monospace; margin: 0; padding: 16px; background: var(--bg); color: var(--fg); }
  h1 { font-size: 15px; margin: 0 0 12px; }
  #layout { display: flex; gap: 24px; align-items: flex-start; }
  #runs { list-style: none; padding: 0; margin: 0; min-width: 220px; }
  #runs li { cursor: pointer; padding: 6px 8px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  #runs li:hover { background: var(--hover); }
  #runs li.selected { background: var(--sel); }
  #detail { min-width: 0; flex: 1; }
  .panel { padding: 2px 0; }
  .label { color: var(--muted); display: inline-block; width: 110px; }
  #stage-strip { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .stage { border: 1px solid var(--line); border-radius: 3px; padding: 2px 8px; color: var(--muted); }
  .stage.done { color: var(--ok); border-color: var(--ok); }
  .stage.running { color: var(--run); border-color: var(--run); }
  .stage.failed { color: var(--bad); border-color: var(--bad); }
  .stage.skipped { color: var(--skip); border-style: dashed; }
  #timeline { margin-top: 12px; }
  #timeline div { padding: 1px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  #version { color: var(--muted); font-weight: normal; font-size: 12px; }
  #version-warn { display: none; color: var(--warn); border: 1px solid var(--warn-line); background: var(--warn-bg); padding: 6px 8px; margin-bottom: 12px; }
  #empty-state { display: none; border: 1px solid var(--line); padding: 12px; margin-bottom: 12px; }
  #empty-state code { background: var(--hover); padding: 1px 4px; }
  @media (max-width: 640px) {
    body { padding: 12px; }
    #layout { flex-direction: column; gap: 12px; align-items: stretch; width: 100%; }
    #runs { min-width: 0; width: 100%; }
    .label { display: block; width: auto; }
  }
</style>
</head>
<body>
<h1>Loki 10 dashboard <span id="version"></span></h1>
<div id="version-warn"></div>
<div id="empty-state">
  No runs yet. Start one with <code>loki start "&lt;brief&gt;"</code>. Not sure your setup works? Run <code>loki doctor</code>.
</div>
<div id="layout">
  <ul id="runs"></ul>
  <div id="detail">
    <div id="panels"></div>
    <div id="stage-strip"></div>
    <div id="timeline"></div>
  </div>
</div>
<script>
(function () {
  var es = null;
  var selectedId = null;
  var STAGES = ["intake", "plan", "wall", "implement", "verify", "seal", "pr"];
  var stageState = {};
  var runStartMs = null;
  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"; });
  }
  function loadVersion() {
    fetch("/version").then(function (r) { return r.json(); }).then(function (v) {
      document.getElementById("version").textContent =
        v.version + (v.cliVersion ? " (CLI " + v.cliVersion + ")" : " (CLI unknown)");
      var warn = document.getElementById("version-warn");
      if (v.cliVersion && v.cliVersion !== v.version) {
        warn.textContent = "Version mismatch: dashboard " + v.version + " vs CLI " + v.cliVersion + ".";
        warn.style.display = "block";
      } else {
        warn.style.display = "none";
      }
    });
  }
  function loadRuns() {
    fetch("/api/runs").then(function (r) { return r.json(); }).then(function (runs) {
      var ul = document.getElementById("runs");
      ul.innerHTML = "";
      document.getElementById("empty-state").style.display = runs.length ? "none" : "block";
      document.getElementById("layout").style.display = runs.length ? "flex" : "none";
      runs.forEach(function (r) {
        var li = document.createElement("li");
        li.textContent = r.runId + " (" + (r.verdict || r.currentStage || "starting") + ")";
        if (r.runId === selectedId) li.className = "selected";
        li.onclick = function () { selectRun(r); };
        ul.appendChild(li);
      });
      if (selectedId === null) autoSelect(runs);
    });
  }
  function autoSelect(runs) {
    if (!runs.length) return;
    var pick = null;
    runs.forEach(function (r) {
      if (!r.verdict && r.currentStage) pick = r;
    });
    if (!pick) {
      pick = runs[0];
      runs.forEach(function (r) { if (r.runId > pick.runId) pick = r; });
    }
    selectRun(pick);
  }
  function fmtClock(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function renderStrip() {
    var now = Date.now();
    document.getElementById("stage-strip").innerHTML = STAGES.map(function (n) {
      var st = stageState[n];
      var cls = st ? st.status : "";
      var note = "";
      if (st && st.status === "running") note = " " + fmtClock(now - st.startMs);
      else if (st && st.status !== "running") note = " " + esc(st.status);
      return '<span class="stage ' + cls + '">' + esc(n) + note + "</span>";
    }).join("");
  }
  function renderPanels(r) {
    document.getElementById("panels").innerHTML = (r.panels || []).map(function (p) {
      return '<div class="panel"><span class="label">' + esc(p.label) + ':</span>' + esc(p.value) + "</div>";
    }).join("");
  }
  function applyStage(e, tsMs) {
    String(e.stage).split("+").forEach(function (n) {
      if (STAGES.indexOf(n) < 0) return;
      if (e.type === "stage.started") stageState[n] = { status: "running", startMs: tsMs };
      else if (e.type === "stage.completed") stageState[n] = { status: "done", startMs: tsMs };
      else if (e.type === "stage.failed") stageState[n] = { status: "failed", startMs: tsMs };
      else if (e.type === "stage.skipped") stageState[n] = { status: "skipped", startMs: tsMs };
    });
  }
  function timelineText(e, tsMs) {
    var clock = "[" + fmtClock(runStartMs === null ? 0 : tsMs - runStartMs) + "] ";
    var d = e.data || {};
    var status = e.type === "stage.completed" ? "done" : e.type === "stage.failed" ? "failed" : e.type === "stage.skipped" ? "skipped" : e.type === "stage.started" ? "started" : null;
    if (e.stage && status) {
      var dur = d.duration_s == null ? "" : "  " + Math.round(Number(d.duration_s)) + "s";
      var detail = d.reason || d.summary || "";
      return clock + e.stage + " " + status + dur + (detail ? "   " + detail : "");
    }
    return clock + (e.stage ? e.stage + " " : "") + e.type;
  }
  function selectRun(r) {
    selectedId = r.runId;
    stageState = {};
    runStartMs = null;
    renderPanels(r);
    renderStrip();
    document.getElementById("timeline").innerHTML = "";
    Array.prototype.forEach.call(document.querySelectorAll("#runs li"), function (li) {
      li.className = li.textContent.indexOf(r.runId + " (") === 0 ? "selected" : "";
    });
    if (es) es.close();
    es = new EventSource("/api/runs/" + encodeURIComponent(r.runId) + "/events");
    es.onmessage = function (m) {
      var e = JSON.parse(m.data);
      var tsMs = Date.parse(e.ts);
      if (runStartMs === null || e.type === "run.started") runStartMs = tsMs;
      var div = document.createElement("div");
      div.textContent = timelineText(e, tsMs);
      document.getElementById("timeline").appendChild(div);
      applyStage(e, tsMs);
      renderStrip();
    };
  }
  setInterval(renderStrip, 1000);
  loadVersion();
  loadRuns();
  setInterval(loadRuns, 5000);
})();
</script>
</body>
</html>
`;
}
/** D61-15: /g/<group> unit grid (rawGroup is the still-encoded path segment); rendering lives in features/speed per D71. */
export const groupRoute = async (repoDir: string, rawGroup: string): Promise<Response> => {
  let group: string;
  try { group = decodeURIComponent(rawGroup); } catch { return new Response("bad group id", { status: 400 }); }
  return (await import("../features/speed/group_grid.ts")).groupResponse(repoDir, group);
};
