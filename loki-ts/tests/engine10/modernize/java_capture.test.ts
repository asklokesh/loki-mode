// M-11: Java 8 to 21 oracle capture (docs/v10/MODERNIZE.md sections 3.2, 7).
// Two layers, tested separately:
//   - autonomy/lib/modernize/java_capture.sh itself, invoked directly with a controlled PATH
//     (no java at all, or a `java` shim that fakes only the -version string) so its JDK-8
//     detection and CaptureRunner reflection logic run for real without needing an actual
//     JDK 8, JaCoCo or Randoop install on this host.
//   - captureJavaUnit's verdict logic (determinism filter, boundary check, coverage floor),
//     tested with a fully stubbed CommandRunner so it never shells out at all.
// This host has a JDK (see java -version) but not 8, and has neither JaCoCo nor Randoop, so
// every path below is exercised deterministically regardless of what the host provides -- a
// missing tool or wrong JDK version is always recorded as NOT PROVEN, never read as passing.
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureJavaUnit, unitClassesFromGraph } from "../../../src/engine10/modernize/oracle/java.ts";
import type { CommandRunner } from "../../../src/engine10/modernize/oracle/java.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "autonomy", "lib", "modernize", "java_capture.sh");
const FIX = join(import.meta.dir, "fixtures", "java8");
const FILES = [
  "com/example/Main.java",
  "com/example/util/Helper.java",
  "com/example/util/Standalone.java",
  "com/example/other/Formatter.java",
  "com/example/NestedUser.java",
];

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

// --------------------------------------------------------------------------------------------
// unitClassesFromGraph: real M-04 (buildJavaGraph) integration, no stubs needed -- it is a
// pure read of the same fixture files java_graph.test.ts already uses.
// --------------------------------------------------------------------------------------------
describe("unitClassesFromGraph (M-04 integration)", () => {
  it("derives fully-qualified class names from the merged M-04 graph's nodes", () => {
    const classes = unitClassesFromGraph(FIX, FILES);
    expect(classes.sort()).toEqual([
      "com.example.Main",
      "com.example.NestedUser",
      "com.example.other.Formatter",
      "com.example.util.Helper",
      "com.example.util.Standalone",
    ]);
  });

  it("drops a non-.java entry the same way buildJavaGraph does", () => {
    const classes = unitClassesFromGraph(FIX, [...FILES, "README.md"]);
    expect(classes).toHaveLength(5);
  });
});

// --------------------------------------------------------------------------------------------
// java_capture.sh itself: real subprocess, controlled PATH, no mocked runner. Standard tools
// (bash/find/sed/grep/mkdir) share a directory (/usr/bin) with the `java` stub on macOS, so
// dropping that whole directory from PATH would silently break the script's own plumbing too.
// Instead this builds one directory of symlinks to every real executable on PATH EXCEPT any
// literally named "java", preserving first-found-wins precedence the same way a real PATH does.
// --------------------------------------------------------------------------------------------
function pathWithoutJava(): string {
  const dir = tmp("e10-javacap-bin-");
  const seen = new Set<string>();
  for (const d of (process.env["PATH"] ?? "").split(":")) {
    if (!d) continue;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === "java" || seen.has(name)) continue;
      const src = join(d, name);
      try {
        if (!statSync(src).isFile()) continue;
        accessSync(src, constants.X_OK);
        symlinkSync(src, join(dir, name));
        seen.add(name);
      } catch {
        // not executable, or a symlink race with another PATH entry -- skip it
      }
    }
  }
  return dir;
}

function noJavaPathDir(): string {
  return pathWithoutJava();
}

/** A PATH whose `java` intercepts `-version` with a fixed string and otherwise execs the real
 *  system java, so compilation and CaptureRunner reflection run for real while the JDK version
 *  this host actually has stays irrelevant to what the script detects. */
function shimJavaPathDir(versionLine: string): string {
  const dir = tmp("e10-javacap-shim-");
  const realJava = spawnSync("/bin/sh", ["-c", "command -v java"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/java";
  const realJavac = spawnSync("/bin/sh", ["-c", "command -v javac"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/javac";
  writeFileSync(
    join(dir, "java"),
    `#!/bin/sh\nif [ "$1" = "-version" ]; then echo '${versionLine.replace(/'/g, "'\\''")}' >&2; exit 0; fi\nexec "${realJava}" "$@"\n`,
  );
  chmodSync(join(dir, "java"), 0o755);
  writeFileSync(join(dir, "javac"), `#!/bin/sh\nexec "${realJavac}" "$@"\n`);
  chmodSync(join(dir, "javac"), 0o755);
  return `${dir}:${pathWithoutJava()}`;
}

function runScript(
  args: string[],
  pathValue: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stderr: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathValue, ...extraEnv },
  });
  return { status: r.status, stderr: r.stderr };
}

function readStatus(outDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(outDir, "status.json"), "utf8"));
}

describe("java_capture.sh (real subprocess)", () => {
  it("exits 2 with usage when a required flag is missing", () => {
    const r = spawnSync("bash", [SCRIPT, "--unit-dir", "/tmp"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });

  it("records NOT PROVEN 'skipped: no JDK 8' when java is not on PATH at all", () => {
    const out = tmp("e10-javacap-out-");
    const r = runScript(["--unit-dir", FIX, "--classes", "com.example.util.Standalone", "--out", out], noJavaPathDir());
    expect(r.status).toBe(0);
    const status = readStatus(out);
    expect(status["jdk8"]).toBe(false);
    expect(status["reasons"]).toContain("skipped: no JDK 8");
    expect(existsSync(join(out, "replay1.jsonl"))).toBe(true);
    expect(readFileSync(join(out, "replay1.jsonl"), "utf8")).toBe("");
  });

  it("records NOT PROVEN 'skipped: no JDK 8' when java reports a non-8 version", () => {
    const out = tmp("e10-javacap-out-");
    const r = runScript(
      ["--unit-dir", FIX, "--classes", "com.example.util.Standalone", "--out", out],
      shimJavaPathDir('openjdk version "21.0.1" 2024-10-15'),
    );
    expect(r.status).toBe(0);
    const status = readStatus(out);
    expect(status["jdk8"]).toBe(false);
    expect(status["reasons"]).toContain("skipped: no JDK 8");
    expect(String(status["jdkVersionRaw"])).toContain("21.0.1");
  });

  it("compiles and captures for real when java reports 1.8, via CaptureRunner reflection", () => {
    const out = tmp("e10-javacap-out-");
    const r = runScript(
      ["--unit-dir", FIX, "--classes", "com.example.util.Standalone",
        "--files", "com/example/util/Standalone.java", "--out", out],
      shimJavaPathDir('openjdk version "1.8.0_412"'),
    );
    expect(r.status).toBe(0);
    const status = readStatus(out);
    expect(status["jdk8"]).toBe(true);
    // no jacoco/randoop jars configured -- recorded, never silently ignored
    expect((status["reasons"] as string[]).some((s) => s.includes("jacoco"))).toBe(true);
    expect((status["reasons"] as string[]).some((s) => s.includes("randoop"))).toBe(true);
    // the existing JUnit suite is never given test classes to run, so it must say so honestly
    // instead of the removed behaviour of running JUnitCore against production classes
    expect((status["reasons"] as string[])).toContain("existing JUnit suite not run: no test classes given to java_capture.sh");

    const replay1 = readFileSync(join(out, "replay1.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    const replay2 = readFileSync(join(out, "replay2.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    expect(replay1.length).toBeGreaterThan(0);
    expect(replay1).toEqual(replay2); // double replay is byte-identical for this deterministic fixture

    const valueCase = replay1.map((l) => JSON.parse(l)).find((c) => c.method?.includes("#value("));
    expect(valueCase).toBeDefined();
    expect(valueCase.return).toEqual({ t: "int", v: "42" });
    expect(valueCase.exc).toBeNull();
  });

  it("keeps status.json valid JSON for the real three-line JDK 8 `java -version` output", () => {
    const out = tmp("e10-javacap-out-");
    const multiline = 'java version "1.8.0_412"\n' +
      "Java(TM) SE Runtime Environment (build 1.8.0_412-b08)\n" +
      "Java HotSpot(TM) 64-Bit Server VM (build 25.412-b08, mixed mode)";
    const r = runScript(
      ["--unit-dir", FIX, "--classes", "com.example.util.Standalone", "--out", out],
      shimJavaPathDir(multiline),
    );
    expect(r.status).toBe(0);
    // readStatus() itself does JSON.parse -- a throw here IS the regression this guards against
    const status = readStatus(out);
    expect(status["jdk8"]).toBe(true);
    expect(String(status["jdkVersionRaw"])).toContain("Java HotSpot");
    expect(String(status["jdkVersionRaw"])).toContain("\n");
  });

  // M-11 round 3 fix: json_escape previously handled only \, ", \n, \r and \t -- any other C0
  // control character (0x00-0x1F) reached status.json raw and broke its JSON syntax, which
  // then made captureJavaUnit misreport a present JDK 8 as "skipped: no JDK 8".
  it("keeps status.json valid JSON when a raw 0x01 control character reaches it via LOKI_MOD_JACOCO_AGENT", () => {
    const out = tmp("e10-javacap-out-");
    const r = runScript(
      ["--unit-dir", FIX, "--classes", "com.example.util.Standalone", "--out", out],
      shimJavaPathDir('openjdk version "1.8.0_412"'),
      { LOKI_MOD_JACOCO_AGENT: "/x\x01y" },
    );
    expect(r.status).toBe(0);
    // readStatus() itself does JSON.parse -- a throw here IS the regression this guards against
    const status = readStatus(out);
    expect(status["jdk8"]).toBe(true);
    expect(status["jacocoAgent"]).toBe("/x\x01y");
  });

  it("keeps status.json valid JSON when a raw 0x1B (ESC) control character reaches it via LOKI_MOD_JACOCO_AGENT", () => {
    const out = tmp("e10-javacap-out-");
    const r = runScript(
      ["--unit-dir", FIX, "--classes", "com.example.util.Standalone", "--out", out],
      shimJavaPathDir('openjdk version "1.8.0_412"'),
      { LOKI_MOD_JACOCO_AGENT: "/x\x1by" },
    );
    expect(r.status).toBe(0);
    const status = readStatus(out);
    expect(status["jdk8"]).toBe(true);
    expect(status["jacocoAgent"]).toBe("/x\x1by");
  });

  it("gives each same-arity overload its own case instead of colliding into one", () => {
    const dir = tmp("e10-javacap-overload-");
    mkdirSync(join(dir, "com", "example"), { recursive: true });
    writeFileSync(
      join(dir, "com", "example", "Over.java"),
      "package com.example;\n" +
        "public class Over {\n" +
        "    public static int add(int a, int b) { return a + b; }\n" +
        "    public static String add(String a, String b) { return a + b; }\n" +
        "}\n",
    );
    const out = tmp("e10-javacap-overload-out-");
    const r = runScript(
      ["--unit-dir", dir, "--classes", "com.example.Over", "--files", "com/example/Over.java", "--out", out],
      shimJavaPathDir('openjdk version "1.8.0_412"'),
    );
    expect(r.status).toBe(0);
    const cases = readFileSync(join(out, "replay1.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const methods = cases.map((c) => c.method);
    expect(new Set(methods).size).toBe(methods.length); // no two overloads collided into one key
    expect(methods).toContain("com.example.Over#add(int,int)");
    expect(methods).toContain("com.example.Over#add(String,String)");
  });

  it("passes each Randoop --testclass as its own argv entry, not one concatenated string", () => {
    const out = tmp("e10-javacap-out-");
    const argvFile = join(out, "randoop-argv.txt");
    const fakeRandoopJar = join(out, "fake-randoop.jar");
    writeFileSync(fakeRandoopJar, "");
    const dir = tmp("e10-javacap-shim2-");
    const realJava = spawnSync("/bin/sh", ["-c", "command -v java"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/java";
    const realJavac = spawnSync("/bin/sh", ["-c", "command -v javac"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/javac";
    writeFileSync(
      join(dir, "java"),
      `#!/bin/sh\n` +
        `if [ "$1" = "-version" ]; then echo 'openjdk version "1.8.0_412"' >&2; exit 0; fi\n` +
        `case " $* " in\n` +
        `  *" randoop.main.Main "*)\n` +
        `    : > "${argvFile}"\n` +
        `    for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done\n` +
        `    exit 0\n` +
        `    ;;\n` +
        `esac\n` +
        `exec "${realJava}" "$@"\n`,
    );
    chmodSync(join(dir, "java"), 0o755);
    writeFileSync(join(dir, "javac"), `#!/bin/sh\nexec "${realJavac}" "$@"\n`);
    chmodSync(join(dir, "javac"), 0o755);
    const pathValue = `${dir}:${pathWithoutJava()}`;

    const r = spawnSync("bash", [SCRIPT,
      "--unit-dir", FIX, "--classes", "com.example.util.Standalone,com.example.util.Helper",
      "--files", "com/example/util/Standalone.java,com/example/util/Helper.java",
      "--out", out, "--randoop-jar", fakeRandoopJar], {
      encoding: "utf8",
      env: { ...process.env, PATH: pathValue },
    });
    expect(r.status).toBe(0);
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv).toContain("--testclass=com.example.util.Standalone");
    expect(argv).toContain("--testclass=com.example.util.Helper");
    // the pre-fix bug collapsed both classes into one argument -- guard against that regression
    expect(argv.some((a) => a.includes("--testclass=com.example.util.Standalone --testclass="))).toBe(false);
  });
});

// --------------------------------------------------------------------------------------------
// captureJavaUnit: verdict logic over a fully stubbed CommandRunner (never shells out).
// --------------------------------------------------------------------------------------------
function writeArtifacts(
  outDir: string,
  opts: { status?: object; replay1?: object[]; replay2?: object[]; jacocoXml?: string },
): void {
  mkdirSync(outDir, { recursive: true });
  if (opts.status) writeFileSync(join(outDir, "status.json"), JSON.stringify(opts.status));
  if (opts.replay1) writeFileSync(join(outDir, "replay1.jsonl"), opts.replay1.map((c) => JSON.stringify(c)).join("\n") + "\n");
  if (opts.replay2) writeFileSync(join(outDir, "replay2.jsonl"), opts.replay2.map((c) => JSON.stringify(c)).join("\n") + "\n");
  if (opts.jacocoXml !== undefined) writeFileSync(join(outDir, "jacoco.xml"), opts.jacocoXml);
}

function stubRunner(artifacts: Parameters<typeof writeArtifacts>[1]): CommandRunner {
  return (_cmd, args) => {
    const outIdx = args.indexOf("--out");
    writeArtifacts(args[outIdx + 1]!, artifacts);
    return { found: true, code: 0 };
  };
}

const CASE_OK = {
  class: "com.example.util.Standalone", method: "com.example.util.Standalone#value(0)",
  args: [], return: { t: "int", v: "42" }, exc: null, stdout: "", not_capturable: [],
};
const JACOCO_90 = `<?xml version="1.0"?><report><package><class></class></package>` +
  `<counter type="BRANCH" missed="1" covered="9"/></report>`;
const JACOCO_50 = `<?xml version="1.0"?><report><counter type="BRANCH" missed="5" covered="5"/></report>`;

describe("captureJavaUnit", () => {
  it("is NOT PROVEN when java_capture.sh itself cannot be run", () => {
    const out = tmp("e10-javacap-unit-");
    const runner: CommandRunner = () => ({ found: false, code: null });
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.proven).toBe(false);
    expect(result.notProven).toContain("skipped: no JDK 8");
    expect(result.caseCount).toBe(0);
    expect(result.coverage.branch_pct).toBeNull();
  });

  it("reports a malformed status.json as its own NOT PROVEN reason, never as 'no JDK 8'", () => {
    const out = tmp("e10-javacap-unit-");
    const runner: CommandRunner = (_cmd, args) => {
      const outIdx = args.indexOf("--out");
      const outDir = args[outIdx + 1]!;
      mkdirSync(outDir, { recursive: true });
      // A status.json that exists but fails to parse -- the exact shape the pre-fix json_escape
      // bug produced (an unescaped raw control byte breaking JSON syntax mid-string).
      writeFileSync(join(outDir, "status.json"), '{"jdk8":true,"jdkVersionRaw":"a\x01b"}');
      return { found: true, code: 0 };
    };
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.proven).toBe(false);
    expect(result.notProven.some((r) => r.startsWith("status.json malformed"))).toBe(true);
    expect(result.notProven).not.toContain("skipped: no JDK 8");
  });

  it("is NOT PROVEN with the script's own reasons when JDK 8 is unavailable", () => {
    const out = tmp("e10-javacap-unit-");
    const runner = stubRunner({
      status: { jdk8: false, jdkVersionRaw: "21.0.1", jacocoAgent: null, jacocoCli: null, randoopJar: null,
        reasons: ["skipped: no JDK 8", "old runtime unavailable: detected 21.0.1"] },
    });
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.proven).toBe(false);
    expect(result.notProven).toContain("old runtime unavailable: detected 21.0.1");
  });

  it("proves a unit when replays agree and coverage clears the 80% floor", () => {
    const out = tmp("e10-javacap-unit-");
    const runner = stubRunner({
      status: { jdk8: true, jdkVersionRaw: "1.8.0", jacocoAgent: "/j.jar", jacocoCli: "/jc.jar", randoopJar: "/r.jar", reasons: [] },
      replay1: [CASE_OK], replay2: [CASE_OK], jacocoXml: JACOCO_90,
    });
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.proven).toBe(true);
    expect(result.notProven).toEqual([]);
    expect(result.caseCount).toBe(1);
    expect(result.coverage.branch_pct).toBe(90);
    const cases = JSON.parse(`[${readFileSync(result.casesPath, "utf8").trim().split("\n").join(",")}]`);
    expect(cases[0].method).toBe("com.example.util.Standalone#value(0)");
    expect(cases[0].return).toEqual({ t: "int", v: "42" });
  });

  it("drops a case whose two replays disagree (nondeterministic)", () => {
    const out = tmp("e10-javacap-unit-");
    const flaky2 = { ...CASE_OK, return: { t: "int", v: "43" } };
    const runner = stubRunner({
      status: { jdk8: true, jdkVersionRaw: "1.8.0", jacocoAgent: "/j.jar", jacocoCli: "/jc.jar", randoopJar: "/r.jar", reasons: [] },
      replay1: [CASE_OK], replay2: [flaky2], jacocoXml: JACOCO_90,
    });
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.caseCount).toBe(0);
    expect(result.nondeterministicCount).toBe(1);
    expect(result.notProven.some((r) => r.startsWith("nondeterministic:"))).toBe(true);
  });

  it("keeps a not-capturable case but flags it, never guessing a value", () => {
    const out = tmp("e10-javacap-unit-");
    const notCapturable = {
      class: "com.example.util.Standalone", method: "com.example.util.Standalone#bad(1)",
      not_capturable: ["boundary:parameter or return type not capturable"],
    };
    const runner = stubRunner({
      status: { jdk8: true, jdkVersionRaw: "1.8.0", jacocoAgent: "/j.jar", jacocoCli: "/jc.jar", randoopJar: "/r.jar", reasons: [] },
      replay1: [notCapturable], replay2: [notCapturable], jacocoXml: JACOCO_90,
    });
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.caseCount).toBe(1);
    expect(result.proven).toBe(false);
    expect(result.notProven.some((r) => r.startsWith("boundary:"))).toBe(true);
  });

  it("flags coverage below the 80% floor without ever rounding up", () => {
    const out = tmp("e10-javacap-unit-");
    const runner = stubRunner({
      status: { jdk8: true, jdkVersionRaw: "1.8.0", jacocoAgent: "/j.jar", jacocoCli: "/jc.jar", randoopJar: "/r.jar", reasons: [] },
      replay1: [CASE_OK], replay2: [CASE_OK], jacocoXml: JACOCO_50,
    });
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.coverage.branch_pct).toBe(50);
    expect(result.notProven.some((r) => r.includes("NOT PROVEN: coverage 50% below 80%"))).toBe(true);
  });

  it("never rounds branch_pct up past the 80% floor (79.996% stays NOT PROVEN)", () => {
    const out = tmp("e10-javacap-unit-");
    const xml = `<?xml version="1.0"?><report><counter type="BRANCH" missed="4001" covered="16000"/></report>`;
    const runner = stubRunner({
      status: { jdk8: true, jdkVersionRaw: "1.8.0", jacocoAgent: "/j.jar", jacocoCli: "/jc.jar", randoopJar: "/r.jar", reasons: [] },
      replay1: [CASE_OK], replay2: [CASE_OK], jacocoXml: xml,
    });
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.coverage.branch_pct).toBe(79.99);
    expect(result.notProven.some((r) => r.includes("NOT PROVEN: coverage 79.99% below 80%"))).toBe(true);
  });

  it("is NOT PROVEN 'coverage not measured', never a fabricated 100%, when jacoco.xml is empty", () => {
    const out = tmp("e10-javacap-unit-");
    const runner = stubRunner({
      status: { jdk8: true, jdkVersionRaw: "1.8.0", jacocoAgent: null, jacocoCli: null, randoopJar: null, reasons: ["jacoco agent not available: coverage not measured"] },
      replay1: [], replay2: [], jacocoXml: "",
    });
    const result = captureJavaUnit({ repoDir: FIX, outDir: out, unitDir: FIX, unitFiles: FILES, runner });
    expect(result.coverage.branch_pct).toBeNull();
    expect(result.notProven).toContain("coverage not measured");
  });
});
