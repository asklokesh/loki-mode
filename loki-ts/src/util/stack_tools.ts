// util/stack_tools.ts -- which build tool each JVM and .NET stack needs, whether it is installed, and how to install it. Split out of engine10/testmap.ts (core line budget). Pure apart from existsSync and Bun.which.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunnerName } from "../engine10/types.ts";
import { lokiYamlTexts, yamlKey } from "./yaml_key.ts";

/** The tool each build-tool runner needs. A repo wrapper (mvnw, gradlew) counts for maven and gradle; dotnet has none. `install` is what the receipt tells the user. */
export const STACK_TOOLS: Partial<Record<RunnerName, { tool: string; wrapper?: string; install: string }>> = {
  maven: { tool: "mvn", wrapper: "mvnw", install: "install Apache Maven (https://maven.apache.org/install.html) or add the mvnw wrapper to the repo" },
  gradle: { tool: "gradle", wrapper: "gradlew", install: "install Gradle (https://gradle.org/install/) or add the gradlew wrapper to the repo" },
  javac: { tool: "javac", install: "install a JDK (https://adoptium.net)" },
  dotnet: { tool: "dotnet", install: "install the .NET SDK (https://dotnet.microsoft.com/download)" },
};
const onPath = (tool: string, env: NodeJS.ProcessEnv): boolean => !!Bun.which(tool, { PATH: env.PATH ?? "" });
export const toolOk = (r: RunnerName, env: NodeJS.ProcessEnv, root?: string): boolean => { const t = STACK_TOOLS[r]; return !t || onPath(t.tool, env) || (!!t.wrapper && !!root && existsSync(join(root, t.wrapper))); };

export const DOTNET_MANIFEST_RE = /(?:^|\/)(?:[^/]+\.(?:sln|slnx|csproj)|global\.json)$/;
const MAVEN_RE = /(?:^|\/)pom\.xml$/, GRADLE_RE = /(?:^|\/)(?:build|settings)\.gradle(?:\.kts)?$|(?:^|\/)gradlew$/;
/** The runner whose tool this repo's files call for (maven, then gradle, then dotnet, then plain javac), else null. */
export function stackRunner(files: readonly string[]): RunnerName | null {
  return files.some((f) => MAVEN_RE.test(f)) ? "maven" : files.some((f) => GRADLE_RE.test(f)) ? "gradle" : files.some((f) => DOTNET_MANIFEST_RE.test(f)) ? "dotnet" : files.some((f) => /\.java$/.test(f)) ? "javac" : null;
}
/** The tool that would run this repo's tests but is not installed, with the install hint; null when present or the repo is none of these stacks. Names the cause so such a repo is never skipped with a bare "no runnable test command". */
export function missingStackTool(files: readonly string[], env: NodeJS.ProcessEnv = process.env, root?: string): { tool: string; install: string } | null {
  const want = stackRunner(files), t = want ? STACK_TOOLS[want] : undefined;
  return want && t && !toolOk(want, env, root) ? { tool: t.tool, install: t.install } : null;
}
/** " (<how to install>)" for a command that is not on PATH, else "" (a tool Loki has no install note for). */
export function installHint(cmd: string): string {
  const e = Object.values(STACK_TOOLS).find((t) => t && (t.tool === cmd || (t.wrapper && cmd === `./${t.wrapper}`)));
  return e ? ` (${e.install})` : "";
}

/** A test file by its language's own convention: a Java file named *Test(s).java, *IT.java or Test*.java under src/test/java (or *Test(s).java anywhere), a C# file named *Test(s).cs / *Spec.cs. */
export const JAVA_TEST_RE = /(?:^|\/)src\/test\/java\/(?:.+\/)?(?:[^/]*(?:Tests?|IT)|Test[^/]*)\.java$|(?:^|\/)[^/]*Tests?\.java$/;
export const CS_TEST_RE = /(?:^|\/)[^/]*(?:Tests?|Spec)\.cs$/;
/** The source stem a Java or C# test covers by naming: CalcTest.java, CalcTests.cs, TestCalc.java -> Calc. */
export const jvmDotnetStem = (name: string): string => name.replace(/\.(?:java|cs)$/, "").replace(/^Test(?=[A-Z])/, "").replace(/(?:Tests?|Spec|IT)$/, "");
/** Identifiers a Java or C# test names (PascalCase words): each may be a source file's basename, so over-selecting is safe. */
export const pascalWords = (text: string): Set<string> => new Set(text.match(/\b[A-Z][A-Za-z0-9]{2,}\b/g) ?? []);

const SKIP_DIRS = new Set([".git", "node_modules", "bin", "obj", ".loki"]);
const ls = (dir: string): { name: string; dir: boolean }[] => { try { return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch { return []; } };
/** What `dotnet test` should be pointed at for the whole repo: the root solution or project, else the first solution up to three levels down, else the first test project; null when none (dotnet then looks at the cwd itself). Always repo-relative. */
export function dotnetTarget(repoDir: string): string | null {
  const walk = (dir: string, depth: number, want: RegExp): string | null => {
    const es = ls(dir).sort((a, b) => a.name.localeCompare(b.name)), hit = es.find((e) => !e.dir && want.test(e.name));
    if (hit) return join(dir, hit.name).slice(repoDir.length + 1);
    if (depth === 0) return null;
    for (const e of es) if (e.dir && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) { const r = walk(join(dir, e.name), depth - 1, want); if (r) return r; }
    return null;
  };
  const root = ls(repoDir).filter((e) => !e.dir && /\.(?:sln|slnx|csproj)$/.test(e.name));
  return root.length === 1 ? root[0]!.name : walk(repoDir, 3, /\.slnx?$/) ?? dotnetTestProject(repoDir);
}
/** Repo-relative path of the first project that references Microsoft.NET.Test.Sdk (a test project), searched three levels down; null when none. */
export function dotnetTestProject(repoDir: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    const es = ls(dir).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of es) if (!e.dir && e.name.endsWith(".csproj")) { try { if (/Microsoft\.NET\.Test\.Sdk/.test(readFileSync(join(dir, e.name), "utf8"))) return join(dir, e.name).slice(repoDir.length + 1); } catch { /* unreadable project: not a proven test project */ } }
    if (depth > 0) for (const e of es) if (e.dir && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) { const r = walk(join(dir, e.name), depth - 1); if (r) return r; }
    return null;
  };
  return walk(repoDir, 3);
}
/** The nearest project (.csproj) at or above a test file, never above repoDir, repo-relative; null when there is none. */
export function dotnetProjectOf(repoDir: string, testRel: string): string | null {
  let d = testRel.includes("/") ? testRel.slice(0, testRel.lastIndexOf("/")) : "";
  for (;;) {
    const hit = ls(join(repoDir, d)).find((e) => !e.dir && e.name.endsWith(".csproj"));
    if (hit) return d ? `${d}/${hit.name}` : hit.name;
    if (!d) return null;
    d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
  }
}

/** The repo's own committed test command: `verify.test_command` in loki.yaml (loki.yml), no environment variable. It replaces the per-runner command for the build-tool stacks (maven, gradle, dotnet, javac), where the build tool owns test discovery, so a multi-module or custom invocation (`./mvnw -B -pl app test`, `dotnet test src/App.sln -c Release`) is what verify runs. The output still goes through the same summary parsers: a command whose output carries no readable test count is not_run, never a pass. A change to loki.yaml caps the verdict (features/runner_config.ts). One line, at most 500 characters, else ignored. */
export function repoTestCommand(repoDir: string): string | null {
  for (const t of lokiYamlTexts(repoDir)) { const v = yamlKey(t, "verify", "test_command"); if (v && v.length <= 500 && !/[\0\r\n]/.test(v)) return v; }
  return null;
}
