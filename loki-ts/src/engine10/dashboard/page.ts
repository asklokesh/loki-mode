// loki-ts/src/engine10/dashboard/page.ts
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
  body { font: 13px/1.5 ui-monospace, monospace; margin: 0; padding: 16px; background: #0b0b0c; color: #ddd; }
  h1 { font-size: 15px; margin: 0 0 12px; }
  #layout { display: flex; gap: 24px; align-items: flex-start; }
  #runs { list-style: none; padding: 0; margin: 0; min-width: 220px; }
  #runs li { cursor: pointer; padding: 6px 8px; border-bottom: 1px solid #222; }
  #runs li:hover { background: #161616; }
  #runs li.selected { background: #1c2b1c; }
  .panel { padding: 2px 0; }
  .label { color: #888; display: inline-block; width: 110px; }
  #timeline { margin-top: 12px; }
  #timeline div { padding: 1px 0; }
  #version { color: #888; font-weight: normal; font-size: 12px; }
  #version-warn { display: none; color: #e8b339; border: 1px solid #5a4a1a; background: #2a220c; padding: 6px 8px; margin-bottom: 12px; }
</style>
</head>
<body>
<h1>Loki 10 dashboard <span id="version"></span></h1>
<div id="version-warn"></div>
<div id="layout">
  <ul id="runs"></ul>
  <div id="detail">
    <div id="panels"></div>
    <div id="timeline"></div>
  </div>
</div>
<script>
(function () {
  var es = null;
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
      runs.forEach(function (r) {
        var li = document.createElement("li");
        li.textContent = r.runId + " (" + (r.verdict || r.currentStage || "starting") + ")";
        li.onclick = function () { selectRun(r); };
        ul.appendChild(li);
      });
    });
  }
  function renderPanels(r) {
    document.getElementById("panels").innerHTML = (r.panels || []).map(function (p) {
      return '<div class="panel"><span class="label">' + esc(p.label) + ':</span>' + esc(p.value) + "</div>";
    }).join("");
  }
  function selectRun(r) {
    renderPanels(r);
    document.getElementById("timeline").innerHTML = "";
    if (es) es.close();
    es = new EventSource("/api/runs/" + encodeURIComponent(r.runId) + "/events");
    es.onmessage = function (m) {
      var e = JSON.parse(m.data);
      var div = document.createElement("div");
      div.textContent = "[" + e.ts + "] " + (e.stage ? e.stage + " " : "") + e.type;
      document.getElementById("timeline").appendChild(div);
    };
  }
  loadVersion();
  loadRuns();
  setInterval(loadRuns, 5000);
})();
</script>
</body>
</html>
`;
}
/** D61-15: /g/<group> unit grid; rendering lives in features/speed per D71. */
export const groupRoute = async (repoDir: string, group: string): Promise<Response> => (await import("../../features/speed/group_grid.ts")).groupResponse(repoDir, group);
