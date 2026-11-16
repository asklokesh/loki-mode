// util/stack_tools.ts -- which build tool each JVM and .NET stack needs, whether it is installed, and how to install it. Split out of engine10/testmap.ts (core line budget). Pure apart from existsSync and Bun.which.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, RunnerName } from "../engine10/types.ts";
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

/** Verify counts Gradle tests from "Class > method PASSED|FAILED|SKIPPED" lines, but Gradle 9.8.2 printed none for a passing run even under -i with testLogging events on (CI run 41267030960; the JUnit XML did list the test). This init script prints exactly that line from an afterTest listener for every Test task, without touching the repo's build files. Written once to a fixed path under the temp dir (content-checked each call). */
const GRADLE_INIT = "allprojects { tasks.withType(Test).configureEach { afterTest { d, r -> println \"${d.className} > ${d.name} ${r.resultType.name() == 'SUCCESS' ? 'PASSED' : r.resultType.name() == 'FAILURE' ? 'FAILED' : 'SKIPPED'}\" } } }\n";
export function gradleInitScript(): string {
  const dir = join(tmpdir(), "loki-gradle-init"), p = join(dir, "test-logging.init.gradle");
  try { if (readFileSync(p, "utf8") !== GRADLE_INIT) throw new Error("stale"); } catch { try { mkdirSync(dir, { recursive: true }); writeFileSync(p, GRADLE_INIT); } catch { /* unwritable temp dir: gradle then runs without it and the count is unmeasured, never a pass */ } }
  return p;
}

// Candidate 1 small environment card (LOKI_E10_ENV_CARD, default on; 0/off/false/no opts out; issue runs on claude only, see e10ext/context.ts issueRunBrief).
// FireLater#24: two sessions ran `which psql pg_ctl postgres redis-server`, found nothing, and never started the database although Postgres 15 was installed as a
// Homebrew keg-only package (not on PATH). Deterministic, no model call, no network; any error gives no card. It never reads or stores env values.
export type ServiceName = "postgres" | "redis" | "mysql" | "mongodb";
const SERVICE_BINS: Record<ServiceName, string[]> = { postgres: ["initdb", "pg_ctl", "postgres"], redis: ["redis-server"], mysql: ["mysqld"], mongodb: ["mongod"] };
const SERVICE_NEED: Record<ServiceName, RegExp> = { postgres: /\b(?:pg|postgres|postgresql|psycopg2?|asyncpg|pgx)\b/i, redis: /\b(?:redis|ioredis)\b/i, mysql: /\b(?:mysql2?|mariadb)\b/i, mongodb: /\b(?:mongodb|mongoose)\b/i };
const KEG_PREFIX: Record<ServiceName, RegExp> = { postgres: /^postgresql/, redis: /^redis/, mysql: /^(?:mysql|mariadb)/, mongodb: /^mongodb/ };
const NEED_FILES = /^(?:package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|\.env\.example)$/;
export interface ServiceFind { service: ServiceName; version: string | null; dir: string; binaries: string[]; on_path: boolean }
/** The services the repository appears to need, from dependency and config files at its root and up to two directories down (node_modules and dot dirs skipped). */
export function neededServices(repoDir: string): ServiceName[] {
  const texts: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && NEED_FILES.test(e.name)) texts.push(readFileSync(join(dir, e.name), "utf8").slice(0, 200_000));
      else if (e.isDirectory() && depth < 2 && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "vendor") walk(join(dir, e.name), depth + 1);
    }
  };
  walk(repoDir, 0);
  const all = texts.join("\n");
  return (Object.keys(SERVICE_NEED) as ServiceName[]).filter((s) => SERVICE_NEED[s].test(all));
}
/** The one detection function (exported for the prove stage too): where the server binaries of each needed service live on this machine. PATH first; then, off
 *  PATH, Homebrew kegs <root>/opt/<keg>/bin for roots /opt/homebrew and /usr/local whose keg name starts with the service's name, /usr/lib/postgresql/<v>/bin and
 *  /Applications/Postgres.app/Contents/Versions/<v>/bin. The highest version wins. `roots` replaces those off-PATH locations (tests: LOKI_E10_ENV_CARD_ROOTS). */
export function detectServiceBinaries(services: readonly ServiceName[], env: NodeJS.ProcessEnv = process.env, roots?: string[]): ServiceFind[] {
  const out: ServiceFind[] = [];
  const pathDirs = (env["PATH"] ?? "").split(":").filter(Boolean);
  const verKey = (v: string | null): number[] => (v ?? "").split(/[^0-9]+/).filter(Boolean).map(Number);
  const newer = (a: string | null, b: string | null): boolean => { const x = verKey(a), y = verKey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); } return false; };
  for (const s of services) {
    const bins = SERVICE_BINS[s];
    const onPath = pathDirs.find((d) => bins.some((b) => existsSync(join(d, b))));
    if (onPath) { out.push({ service: s, version: null, dir: onPath, binaries: bins.filter((b) => existsSync(join(onPath, b))), on_path: true }); continue; }
    const cands: { dir: string; version: string | null }[] = [];
    const kegRoots = roots ?? ["/opt/homebrew/opt", "/usr/local/opt"];
    for (const r of kegRoots) if (existsSync(r)) for (const k of readdirSync(r)) if (KEG_PREFIX[s].test(k)) cands.push({ dir: join(r, k, "bin"), version: /@([\d.]+)$/.exec(k)?.[1] ?? null });
    if (s === "postgres" && !roots) {
      for (const [base, sub] of [["/usr/lib/postgresql", "bin"], ["/Applications/Postgres.app/Contents/Versions", "bin"]] as const) if (existsSync(base)) for (const v of readdirSync(base)) cands.push({ dir: join(base, v, sub), version: /^[\d.]+$/.test(v) ? v : null });
    }
    let best: { dir: string; version: string | null; have: string[] } | null = null;
    for (const c of cands) { const have = bins.filter((b) => existsSync(join(c.dir, b))); if (have.length && (!best || newer(c.version, best.version))) best = { ...c, have }; }
    if (best) out.push({ service: s, version: best.version, dir: best.dir, binaries: best.have, on_path: false });
  }
  return out;
}
/** The brief line for the services found off PATH, or null. */
export function envCardLine(found: readonly ServiceFind[]): string | null {
  const off = found.filter((f) => !f.on_path);
  if (!off.length) return null;
  return `Available on this machine: ${off.map((f) => `${f.service}${f.version ? ` ${f.version}` : ""} (${f.binaries.join(", ")}) in ${f.dir}`).join("; ")}. Their directories are on your PATH.`;
}
export const envCardOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_ENV_CARD"] ?? "").trim());
/** The implement stage's card: the brief line and the directories to append to the implement session's PATH. Writes <runDir>/env-card.json and one env.card
 *  event. Null when off, when nothing is needed or found off PATH, or on any error (never fails the run). */
export function envCard(ctx: Pick<RunContext, "repoDir" | "runDir" | "emit">, env: NodeJS.ProcessEnv = process.env): { line: string; pathAppend: string[] } | null {
  try {
    if (!envCardOn(env)) return null;
    const needed = neededServices(ctx.repoDir);
    const rootsRaw = (env["LOKI_E10_ENV_CARD_ROOTS"] ?? "").trim();
    const found = needed.length ? detectServiceBinaries(needed, env, rootsRaw ? rootsRaw.split(":").filter(Boolean) : undefined) : [];
    const line = envCardLine(found), pathAppend = [...new Set(found.filter((f) => !f.on_path).map((f) => f.dir))];
    mkdirSync(ctx.runDir, { recursive: true });
    writeFileSync(join(ctx.runDir, "env-card.json"), JSON.stringify({ needed, found, path_appended: pathAppend, line }, null, 2) + "\n");
    ctx.emit("env.card", "implement", { needed, found: found.map((f) => ({ service: f.service, version: f.version, dir: f.dir, on_path: f.on_path })), path_appended: pathAppend });
    return line ? { line, pathAppend } : null;
  } catch { return null; }
}
/** Q1 PROVE: the card envCard wrote, read back for the prover session and its scripts (the same PATH append and brief line) and for the receipt. Null when absent or unreadable. */
export interface EnvCardFile { needed: ServiceName[]; found: ServiceFind[]; path_appended: string[]; line: string | null }
export function readEnvCardFile(runDir: string): EnvCardFile | null {
  try { const c = JSON.parse(readFileSync(join(runDir, "env-card.json"), "utf8")) as EnvCardFile; return c && Array.isArray(c.needed) && Array.isArray(c.found) ? { ...c, path_appended: Array.isArray(c.path_appended) ? c.path_appended : [] } : null; } catch { return null; }
}
/** Services the repository needs that the card found nowhere on this machine. */
export const missingServices = (c: EnvCardFile | null): ServiceName[] => (c ? c.needed.filter((s) => !c.found.some((f) => f.service === s)) : []);
/** The receipt's env_card: only when the card was built and the repository needs a service (needed, found, path appended). */
export const envCardReceiptBlock = (runDir: string): { env_card?: { needed: ServiceName[]; found: ServiceFind[]; path_appended: string[] } } => { const c = readEnvCardFile(runDir); return c && c.needed.length ? { env_card: { needed: c.needed, found: c.found, path_appended: c.path_appended } } : {}; };
