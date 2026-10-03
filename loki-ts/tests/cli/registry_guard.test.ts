// Registry guard (CLI-MODERN-1). Lists are derived by parsing, never pinned:
//  - every command the bash dispatcher (autonomy/loki main() case arms) or the
//    loki-ts dispatcher (cli.ts) accepts must be in the registry, and every
//    registry command must be accepted by one of them;
//  - nested bash subcommands (case arms inside each cmd_* handler) are checked the
//    same way, with tests/fixtures/cli-registry-known-gaps.txt listing the paths
//    not yet filled; the file may only shrink (set UPDATE_GAPS=1 to rewrite it);
//  - generated completions cover every visible command, every enum value and
//    every dynamic kind, and the generated scripts parse and behave.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../src/util/paths.ts";
import { REGISTRY, allNames, findCommand, registryPaths, suggestCommand, visibleCommands } from "../../src/cli/registry.ts";
import { allTreeFlags, generateBash, generateFish, generateZsh } from "../../src/cli/completions.ts";
import { readGaps, renderDoc } from "../../src/cli/inventory_doc.ts";

const BASH_SRC = readFileSync(join(REPO_ROOT, "autonomy", "loki"), "utf8").split("\n");
const TS_SRC = readFileSync(join(REPO_ROOT, "loki-ts", "src", "cli.ts"), "utf8");

function mainBody(): string[] {
  const start = BASH_SRC.findIndex((l) => l.startsWith("main() {"));
  if (start < 0) throw new Error("main() not found");
  const end = BASH_SRC.findIndex((l, i) => i > start && l === "}");
  return BASH_SRC.slice(start, end);
}

function arms(lines: string[], indent: number): { labels: string[]; at: number }[] {
  const re = new RegExp(`^ {${indent}}([A-Za-z0-9_|*.-]+)\\)`);
  const out: { labels: string[]; at: number }[] = [];
  lines.forEach((l, i) => {
    const m = re.exec(l);
    if (m) out.push({ labels: m[1]!.split("|"), at: i });
  });
  return out;
}

function bashTop(): { labels: string[]; body: string }[] {
  const body = mainBody();
  const a = arms(body, 8);
  return a.map((x, i) => ({ labels: x.labels, body: body.slice(x.at, a[i + 1]?.at ?? body.length).join("\n") }));
}

function bunTop(): string[] {
  const start = TS_SRC.indexOf("async function dispatch");
  return [...TS_SRC.slice(start).matchAll(/^ {4}case "([^"]+)":/gm)].map((m) => m[1]!);
}

const registryNames = new Set(REGISTRY.flatMap(allNames));

function bashNested(): string[] {
  const out: string[] = [];
  for (const arm of bashTop()) {
    const canon = arm.labels.map((l) => findCommand(l)).find(Boolean);
    if (!canon) continue;
    const fn = /\b(cmd_[a-z0-9_]+)\b/.exec(arm.body)?.[1];
    if (!fn) continue;
    const s = BASH_SRC.findIndex((l) => l.startsWith(`${fn}() {`));
    if (s < 0) continue;
    const e = BASH_SRC.findIndex((l, i) => i > s && l === "}");
    const fnLines = BASH_SRC.slice(s, e);
    const ci = fnLines.findIndex((l) => /^\s*case "\$\{?(1|sub|subcmd|subcommand|action|cmd|command)(:-[^}]*)?\}?" in\s*$/.test(l));
    if (ci < 0) continue;
    const indent = /^( *)/.exec(fnLines[ci]!)![1]!.length;
    const endIdx = fnLines.findIndex((l, i) => i > ci && l === `${" ".repeat(indent)}esac`);
    const block = fnLines.slice(ci + 1, endIdx < 0 ? undefined : endIdx);
    for (const a of arms(block, indent + 4)) {
      for (const l of a.labels) if (/^[a-z][a-z0-9_-]*$/.test(l)) out.push(`${canon.name} ${l}`);
    }
  }
  return [...new Set(out)];
}

describe("registry vs dispatchers", () => {
  test("parsers find the dispatch tables", () => {
    expect(bashTop().length).toBeGreaterThan(20);
    expect(bunTop().length).toBeGreaterThan(10);
  });

  test("every command a dispatcher accepts is in the registry", () => {
    const accepted = new Set([...bashTop().flatMap((a) => a.labels), ...bunTop()]);
    accepted.delete("*");
    const missing = [...accepted].filter((l) => !registryNames.has(l)).sort();
    expect(missing).toEqual([]);
  });

  test("every registry command is accepted by a dispatcher", () => {
    const accepted = new Set([...bashTop().flatMap((a) => a.labels), ...bunTop()]);
    const stale = [...registryNames].filter((n) => !accepted.has(n)).sort();
    expect(stale).toEqual([]);
  });

  test("nested bash subcommands: gaps match the known-gaps file exactly", () => {
    const paths = new Set(registryPaths());
    const gaps = bashNested()
      .filter((p) => {
        const top = findCommand(p.split(" ")[0]!)!;
        return top.cls === "KEEP-MODERN" || top.cls === "UPDATE";
      })
      .filter((p) => !paths.has(p))
      .sort();
    const file = join(REPO_ROOT, "loki-ts", "tests", "fixtures", "cli-registry-known-gaps.txt");
    if (process.env["UPDATE_GAPS"] === "1") {
      writeFileSync(file, "# Nested bash subcommands accepted by autonomy/loki but not yet in the registry.\n# This file may only shrink; registry_guard.test.ts fails on any difference.\n" + gaps.join("\n") + "\n");
    }
    expect(gaps).toEqual(readGaps(REPO_ROOT).sort());
  });

  test("registry subcommands of bash-only commands are accepted by bash", () => {
    const nested = new Set(bashNested());
    for (const c of REGISTRY) {
      if (c.where !== "bash" || !c.subcommands) continue;
      if (![...nested].some((p) => p.startsWith(`${c.name} `))) continue; // handler not parseable
      for (const s of c.subcommands) expect(nested.has(`${c.name} ${s.name}`)).toBe(true);
    }
  });

  test("CLI-MODERN.md matches the registry", () => {
    expect(readFileSync(join(REPO_ROOT, "docs", "v10", "CLI-MODERN.md"), "utf8")).toBe(renderDoc(REPO_ROOT));
  });
});

describe("completions", () => {
  const bash = generateBash();
  const zsh = generateZsh();
  const fish = generateFish();

  test("every visible command is offered in all three shells", () => {
    for (const c of visibleCommands()) {
      for (const n of [c.name, ...(c.aliases ?? [])].slice(0, 1)) {
        expect(bash.includes(`${n}\t`)).toBe(true);
        expect(zsh.includes(`${n}\t`)).toBe(true);
        expect(fish.includes(`-a '${n}'`)).toBe(true);
      }
    }
  });

  test("hidden, legacy and deprecated commands are not offered", () => {
    for (const c of REGISTRY.filter((x) => !visibleCommands().includes(x))) {
      expect(bash.includes(`\n${c.name}\t${c.desc}`)).toBe(false);
      expect(fish.includes(`-a '${c.name}' -d '${c.desc}`)).toBe(false);
    }
  });

  test("every enum value and dynamic kind appears in every shell", () => {
    for (const { flag } of allTreeFlags()) {
      if (flag.type === "enum") for (const v of flag.values ?? []) for (const s of [bash, zsh, fish]) expect(s.includes(v)).toBe(true);
      if (flag.type === "dynamic") {
        expect(bash.includes(`@dyn:${flag.dynamic}`)).toBe(true);
        expect(zsh.includes(`@dyn:${flag.dynamic}`)).toBe(true);
        expect(fish.includes(`__complete ${flag.dynamic}`)).toBe(true);
      }
    }
  });

  test("generated scripts parse", () => {
    expect(spawnSync("bash", ["-n"], { input: bash }).status).toBe(0);
    if (spawnSync("zsh", ["--version"]).status === 0) expect(spawnSync("zsh", ["-n", "/dev/stdin"], { input: zsh }).status).toBe(0);
  });

  function complete(words: string[]): string[] {
    const cw = words.map((w) => `'${w}'`).join(" ");
    const script = `${bash}\nloki() { printf 'claude\\ncodex\\n'; }\nCOMP_WORDS=(${cw}); COMP_CWORD=$(( \${#COMP_WORDS[@]} - 1 )); _loki_complete; printf '%s\\n' "\${COMPREPLY[@]}"`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    return r.stdout.split("\n").filter(Boolean);
  }

  test("bash: commands, subcommands, flag values, exclusivity", () => {
    expect(complete(["loki", "sta"])).toContain("start");
    expect(complete(["loki", "control", ""])).toEqual(expect.arrayContaining(["serve", "prune"]));
    expect(complete(["loki", "start", "--provider", ""])).toEqual(["claude", "codex"]);
    expect(complete(["loki", "start", "--isolation", ""])).toEqual(["none", "worktree", "docker"]);
    const flags = complete(["loki", "start", "--simple", "--"]);
    expect(flags).toContain("--provider");
    expect(flags).not.toContain("--simple");
    expect(flags).not.toContain("--complex");
  });
});

describe("did you mean", () => {
  test("suggests within distance 2 and stays silent beyond", () => {
    expect(suggestCommand("statsu")).toBe("status");
    expect(suggestCommand("provder")).toBe("provider");
    expect(suggestCommand("zzzzzzzz")).toBeUndefined();
  });
});
