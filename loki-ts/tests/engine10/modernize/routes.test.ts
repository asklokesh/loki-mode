// M-19: strangler targets and routes.json (py2/dual/py3, per-module release).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { applySwitch, loadRoutes, markProven, saveRoutes, switchRoute } from "../../../src/engine10/modernize/routes.ts";
import type { RouteMap } from "../../../src/engine10/modernize/routes.ts";
import { routesPath } from "../../../src/engine10/modernize/types.ts";
import { PY_ROUTE_STATUSES, envsForUnit, generateToxIni } from "../../../src/engine10/modernize/targets/python3.ts";
import { JAVA_ROUTE_STATUSES, patchBuildFileRelease, releaseForModule } from "../../../src/engine10/modernize/targets/java21.ts";

let repoDir = "";
beforeEach(() => { repoDir = mkdtempSync(join(tmpdir(), "e10-mod-routes-")); });
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

const mid = "mod-20260928T010203Z-ab12cd";

describe("loadRoutes/saveRoutes", () => {
  it("loads an empty map when routes.json does not exist yet", () => {
    expect(loadRoutes(repoDir, mid)).toEqual({});
  });

  it("round-trips through routes.json", () => {
    const routes: RouteMap = { "u-0": { status: "py2", proven: false } };
    saveRoutes(repoDir, mid, routes);
    expect(existsSync(routesPath(repoDir, mid))).toBe(true);
    expect(loadRoutes(repoDir, mid)).toEqual(routes);
  });

  it("treats a corrupt file as no routes rather than throwing", () => {
    saveRoutes(repoDir, mid, {});
    writeFileSync(routesPath(repoDir, mid), "{not json");
    expect(loadRoutes(repoDir, mid)).toEqual({});
  });
});

describe("switchRoute", () => {
  it("rejects an unknown status", () => {
    const r = switchRoute({}, "u-0", "py4", PY_ROUTE_STATUSES);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unknown status");
  });

  it("sets a fresh route, unproven", () => {
    const r = switchRoute({}, "u-0", "py2", PY_ROUTE_STATUSES);
    expect(r.ok).toBe(true);
    expect(r.routes["u-0"]).toEqual({ status: "py2", proven: false });
  });

  it("allows any move, forward or back, while unproven", () => {
    let routes: RouteMap = {};
    routes = switchRoute(routes, "u-0", "dual", PY_ROUTE_STATUSES).routes;
    const back = switchRoute(routes, "u-0", "py2", PY_ROUTE_STATUSES);
    expect(back.ok).toBe(true);
    expect(back.routes["u-0"]?.status).toBe("py2");
  });

  it("allows a forward move once proven", () => {
    let routes: RouteMap = switchRoute({}, "u-0", "dual", PY_ROUTE_STATUSES).routes;
    routes = markProven(routes, "u-0");
    const r = switchRoute(routes, "u-0", "py3", PY_ROUTE_STATUSES);
    expect(r.ok).toBe(true);
    expect(r.routes["u-0"]?.status).toBe("py3");
  });

  it("refuses to switch back once proven (section 8)", () => {
    let routes: RouteMap = switchRoute({}, "u-0", "dual", PY_ROUTE_STATUSES).routes;
    routes = markProven(routes, "u-0");
    const r = switchRoute(routes, "u-0", "py2", PY_ROUTE_STATUSES);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("proven");
    expect(routes["u-0"]?.status).toBe("dual"); // unchanged
  });

  it("markProven is a no-op for a key with no route", () => {
    expect(markProven({}, "u-0")).toEqual({});
  });
});

describe("applySwitch", () => {
  it("persists the route and appends route.switched on success", () => {
    const log = new ModernizeLog(repoDir, mid, () => "2026-09-28T01:02:04.000Z");
    const r = applySwitch(repoDir, mid, log, {}, "u-0", "py2", PY_ROUTE_STATUSES);
    expect(r.ok).toBe(true);
    expect(loadRoutes(repoDir, mid)).toEqual({ "u-0": { status: "py2", proven: false } });
    const events = readModernizeEvents(repoDir, mid);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("route.switched");
    expect(events[0]?.data).toEqual({ key: "u-0", to: "py2", from: null });
  });

  it("neither persists nor logs a rejected switch", () => {
    const log = new ModernizeLog(repoDir, mid, () => "2026-09-28T01:02:04.000Z");
    const r = applySwitch(repoDir, mid, log, {}, "u-0", "py4", PY_ROUTE_STATUSES);
    expect(r.ok).toBe(false);
    expect(existsSync(routesPath(repoDir, mid))).toBe(false);
    expect(readModernizeEvents(repoDir, mid).length).toBe(0);
  });
});

describe("python3 target", () => {
  it("maps each route status to its tox envs", () => {
    expect(envsForUnit({ "u-0": { status: "py2", proven: false } }, "u-0")).toEqual(["py27"]);
    expect(envsForUnit({ "u-0": { status: "dual", proven: false } }, "u-0")).toEqual(["py27", "py3"]);
    expect(envsForUnit({ "u-0": { status: "py3", proven: false } }, "u-0")).toEqual(["py3"]);
  });

  it("defaults an unrouted unit to py2 envs", () => {
    expect(envsForUnit({}, "u-0")).toEqual(["py27"]);
  });

  it("generates a tox.ini with one section per claimed env", () => {
    const routes: RouteMap = {
      "u-0": { status: "py2", proven: false },
      "u-1": { status: "dual", proven: false },
    };
    const ini = generateToxIni(routes, ["u-0", "u-1"]);
    expect(ini).toContain("envlist = py27, py3");
    expect(ini).toContain("[testenv:py27]");
    expect(ini).toContain("# units: u-0, u-1");
    expect(ini).toContain("[testenv:py3]");
    expect(ini).toContain("# units: u-1");
  });
});

describe("java21 target", () => {
  it("defaults an unrouted module to release 8", () => {
    expect(releaseForModule({}, "core")).toBe("8");
  });

  it("reads the routed release", () => {
    expect(releaseForModule({ core: { status: "21", proven: false } }, "core")).toBe("21");
  });

  it("inserts a maven release into an existing properties block", () => {
    const pom = "<project>\n  <properties>\n    <x>1</x>\n  </properties>\n</project>";
    const out = patchBuildFileRelease("maven", pom, "21");
    expect(out).toContain("<maven.compiler.release>21</maven.compiler.release>");
    expect(out).toContain("<x>1</x>"); // rest of the file is untouched
  });

  it("replaces an existing maven release rather than duplicating it", () => {
    const pom = "<project>\n  <properties>\n    <maven.compiler.release>8</maven.compiler.release>\n  </properties>\n</project>";
    const out = patchBuildFileRelease("maven", pom, "21");
    expect(out.match(/maven\.compiler\.release/g)?.length).toBe(2); // one open tag, one close tag
    expect(out).toContain("<maven.compiler.release>21</maven.compiler.release>");
  });

  it("adds a properties block to a maven pom that has none", () => {
    const pom = "<project>\n  <artifactId>x</artifactId>\n</project>";
    const out = patchBuildFileRelease("maven", pom, "21");
    expect(out).toContain("<properties>");
    expect(out).toContain("<maven.compiler.release>21</maven.compiler.release>");
  });

  it("replaces an existing gradle release rather than duplicating it", () => {
    const build = "tasks.withType(JavaCompile) {\n  options.release.set(8)\n}\n";
    const out = patchBuildFileRelease("gradle", build, "21");
    expect(out).toContain("options.release.set(21)");
    expect(out.match(/options\.release\.set/g)?.length).toBe(1);
  });

  it("appends a gradle release block when none exists", () => {
    const build = "plugins { id 'java' }\n";
    const out = patchBuildFileRelease("gradle", build, "21");
    expect(out).toContain("options.release.set(21)");
  });

  it("leaves non-java build systems untouched", () => {
    const content = "[tool.poetry]\n";
    expect(patchBuildFileRelease("poetry", content, "21")).toBe(content);
  });

  it("validates the exported route status lists", () => {
    expect(JAVA_ROUTE_STATUSES).toEqual(["8", "21"]);
  });
});
