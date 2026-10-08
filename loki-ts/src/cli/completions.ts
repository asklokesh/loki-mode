// Shell completion generators (bash, zsh, fish) driven entirely by the registry,
// the dynamic value source behind `loki __complete <kind>`, and the automatic
// installer (npm postinstall + first interactive run after an upgrade).
// Nothing here is hand-maintained: add a command to registry.ts and every shell
// picks it up. Legacy (DROP-LEGACY), DELETE and hidden entries are never offered.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GLOBAL_FLAGS, allNames, visibleCommands, type CmdSpec, type DynKind, type FlagSpec, type PositionalSpec } from "./registry.ts";
import { REPO_ROOT } from "../util/paths.ts";
import { safeGitSpawn } from "../util/safe_git.ts";

export type Shell = "bash" | "zsh" | "fish";

interface Node {
  key: string; // "control/serve"
  names: string[]; // canonical name first, then aliases
  parent: string; // key of the parent ("" for top level)
  desc: string;
  flags: FlagSpec[];
  positionals: readonly PositionalSpec[];
  children: Node[];
}

function build(c: CmdSpec, parent: string): Node {
  const key = parent ? `${parent}/${c.name}` : c.name;
  return {
    key,
    names: allNames(c),
    parent,
    desc: c.desc,
    flags: [...(c.flags ?? []), ...GLOBAL_FLAGS],
    positionals: c.positionals ?? [],
    children: (c.subcommands ?? []).filter((s) => !s.hidden).map((s) => build(s, key)),
  };
}

/** The visible command tree (root key ""). Exported for the guard test. */
export function completionTree(): Node {
  return {
    key: "",
    names: [],
    parent: "",
    desc: "",
    flags: [...GLOBAL_FLAGS],
    positionals: [],
    children: visibleCommands().map((c) => build(c, "")),
  };
}

function flatten(n: Node): Node[] {
  return [n, ...n.children.flatMap(flatten)];
}

/** Every flag spec reachable in the tree, for the guard. */
export function allTreeFlags(): { key: string; flag: FlagSpec }[] {
  return flatten(completionTree()).flatMap((n) => n.flags.map((flag) => ({ key: n.key, flag })));
}

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const fq = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function flagHint(f: FlagSpec): string {
  return f.type === "string" || f.type === "int" ? `${f.desc} ${f.placeholder ?? ""}`.trim() : f.desc;
}
function flagNames(f: FlagSpec): string[] {
  return f.short ? [f.name, f.short] : [f.name];
}

/** Lines "value" for enum flags, "@dyn:kind" for dynamic, "@path", or "" for none. */
function flagValueSpec(f: FlagSpec): string {
  if (f.type === "enum") return (f.values ?? []).join(" ");
  if (f.type === "dynamic") return `@dyn:${f.dynamic}`;
  if (f.type === "path") return "@path";
  return "";
}
function posSpec(n: Node): string[] {
  return n.positionals.map((p) => (p.type === "enum" ? (p.values ?? []).join(" ") : p.type === "dynamic" ? `@dyn:${p.dynamic}` : p.type === "path" ? "@path" : ""));
}

// Shared case-table emitters (bash and zsh use the same helper function bodies).
function helperFunctions(nodes: Node[], shell: "bash" | "zsh"): string {
  const out: string[] = [];
  // node lookup: "<parent>|<word>" -> canonical key (aliases resolve)
  out.push("_loki_node() {", '  case "$1|$2" in');
  for (const n of nodes) for (const name of n.names) if (n.key) out.push(`    ${sq(`${n.parent}|${name}`)}) printf '%s' ${sq(n.key)} ;;`);
  out.push("  esac", "}");
  // subcommand listing "name<TAB>desc"
  out.push("_loki_subs() {", '  case "$1" in');
  for (const n of nodes) {
    if (!n.children.length) continue;
    const lines = n.children.map((c) => `${c.names[0]}\t${c.desc}`).join("\n");
    out.push(`    ${sq(n.key)}) printf '%s\\n' ${sq(lines)} ;;`);
  }
  out.push("  esac", "}");
  // flags "name<TAB>desc"
  out.push("_loki_flags() {", '  case "$1" in');
  for (const n of nodes) {
    const lines = n.flags.flatMap((f) => flagNames(f).map((nm) => `${nm}\t${flagHint(f)}`)).join("\n");
    out.push(`    ${sq(n.key)}) printf '%s\\n' ${sq(lines)} ;;`);
  }
  out.push("  esac", "}");
  // flag value spec
  out.push("_loki_flagval() {", '  case "$1|$2" in');
  for (const n of nodes) for (const f of n.flags) {
    const spec = flagValueSpec(f);
    if (spec) out.push(`    ${flagNames(f).map((nm) => sq(`${n.key}|${nm}`)).join("|")}) printf '%s' ${sq(spec)} ;;`);
  }
  out.push("  esac", "}");
  // exclusivity: flags to hide once $2 is used
  out.push("_loki_excl() {", '  case "$1|$2" in');
  for (const n of nodes) for (const f of n.flags) {
    if (f.excludes?.length) out.push(`    ${flagNames(f).map((nm) => sq(`${n.key}|${nm}`)).join("|")}) printf '%s' ${sq(f.excludes.join(" "))} ;;`);
  }
  out.push("  esac", "}");
  // positional spec (union across positionals)
  out.push("_loki_pos() {", '  case "$1" in');
  for (const n of nodes) {
    const s = posSpec(n).filter(Boolean).join(" ");
    if (s) out.push(`    ${sq(n.key)}) printf '%s' ${sq(s)} ;;`);
  }
  out.push("  esac", "}");
  void shell;
  return out.join("\n");
}

export function generateBash(): string {
  const nodes = flatten(completionTree());
  return `# loki bash completion (generated from loki-ts/src/cli/registry.ts; do not edit)
${helperFunctions(nodes, "bash")}
_loki_dynvals() {
  local spec="$1" kind
  case "$spec" in
    @dyn:*) kind="\${spec#@dyn:}"; loki __complete "$kind" 2>/dev/null ;;
    @path) ;;
    *) printf '%s\\n' $spec ;;
  esac
}
_loki_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="" key="" i w n spec line
  [ "$COMP_CWORD" -gt 0 ] && prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local used=" " hide=" "
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    case "$w" in
      -*) used="$used$w "; hide="$hide$(_loki_excl "$key" "$w") " ;;
      *) n="$(_loki_node "$key" "$w")"; [ -n "$n" ] && key="$n" ;;
    esac
  done
  COMPREPLY=()
  case "$prev" in
    -*)
      spec="$(_loki_flagval "$key" "$prev")"
      if [ "$spec" = "@path" ]; then COMPREPLY=($(compgen -f -- "$cur")); return; fi
      if [ -n "$spec" ]; then COMPREPLY=($(compgen -W "$(_loki_dynvals "$spec")" -- "$cur")); return; fi ;;
  esac
  if [[ "$cur" == -* ]]; then
    local names=""
    while IFS=$'\\t' read -r n line; do
      [ -z "$n" ] && continue
      case "$used$hide" in *" $n "*) continue ;; esac
      names="$names $n"
    done < <(_loki_flags "$key")
    COMPREPLY=($(compgen -W "$names" -- "$cur"))
    return
  fi
  local words=""
  while IFS=$'\\t' read -r n line; do words="$words $n"; done < <(_loki_subs "$key")
  spec="$(_loki_pos "$key")"
  if [ -n "$spec" ]; then
    for line in $spec; do case "$line" in @path) COMPREPLY+=($(compgen -f -- "$cur")) ;; *) words="$words $(_loki_dynvals "$line" | tr '\\n' ' ')" ;; esac; done
  fi
  COMPREPLY+=($(compgen -W "$words" -- "$cur"))
}
complete -o default -F _loki_complete loki
`;
}

export function generateZsh(): string {
  const nodes = flatten(completionTree());
  return `#compdef loki
# loki zsh completion (generated from loki-ts/src/cli/registry.ts; do not edit)
${helperFunctions(nodes, "zsh")}
_loki_dynvals() {
  case "$1" in
    @dyn:*) loki __complete "\${1#@dyn:}" 2>/dev/null ;;
    @path) ;;
    *) print -l \${=1} ;;
  esac
}
_loki() {
  local key="" w n i spec cur="\${words[CURRENT]}" prev="\${words[CURRENT-1]}"
  local used=" " hide=" "
  for ((i = 2; i < CURRENT; i++)); do
    w="\${words[i]}"
    case "$w" in
      -*) used="$used$w "; hide="$hide$(_loki_excl "$key" "$w") " ;;
      *) n="$(_loki_node "$key" "$w")"; [[ -n "$n" ]] && key="$n" ;;
    esac
  done
  local -a vals items
  if [[ "$prev" == -* ]]; then
    spec="$(_loki_flagval "$key" "$prev")"
    if [[ "$spec" == @path ]]; then _files; return; fi
    if [[ -n "$spec" ]]; then vals=(\${(f)"$(_loki_dynvals "$spec")"}); compadd -a vals; return; fi
  fi
  if [[ "$cur" == -* ]]; then
    local line
    for line in \${(f)"$(_loki_flags "$key")"}; do
      n="\${line%%$'\\t'*}"
      [[ "$used$hide" == *" $n "* ]] && continue
      items+=("\${n}:\${line#*$'\\t'}")
    done
    _describe -t options 'option' items
    return
  fi
  local line
  for line in \${(f)"$(_loki_subs "$key")"}; do items+=("\${line%%$'\\t'*}:\${line#*$'\\t'}"); done
  (( \${#items} )) && _describe -t commands 'command' items
  spec="$(_loki_pos "$key")"
  if [[ -n "$spec" ]]; then
    for line in \${=spec}; do
      if [[ "$line" == @path ]]; then _files; else vals=(\${(f)"$(_loki_dynvals "$line")"}); (( \${#vals} )) && compadd -a vals; fi
    done
  fi
}
_loki "$@"
`;
}

export function generateFish(): string {
  const nodes = flatten(completionTree());
  const out: string[] = ["# loki fish completion (generated from loki-ts/src/cli/registry.ts; do not edit)"];
  out.push("function __loki_node", "  switch \"$argv[1]|$argv[2]\"");
  for (const n of nodes) for (const name of n.names) if (n.key) out.push(`    case ${fq(`${n.parent}|${name}`)}; echo ${fq(n.key)}`);
  out.push("  end", "end");
  out.push("function __loki_path", "  set -l key ''", "  for w in (commandline -opc)[2..-1]", "    switch $w", "      case '-*'; continue", "    end", "    set -l n (__loki_node $key $w)", "    test -n \"$n\"; and set key $n", "  end", "  test -n \"$key\"; and echo $key", "end");
  const at = (key: string): string => (key ? `test (__loki_path) = ${fq(key)}` : "test (count (__loki_path)) -eq 0");
  for (const n of nodes) {
    for (const c of n.children) out.push(`complete -c loki -f -n ${fq(at(n.key))} -a ${fq(c.names[0]!)} -d ${fq(c.desc)}`);
    for (const f of n.flags) {
      const flagArg = f.name.startsWith("--") ? `-l ${f.name.slice(2)}` : `-s ${f.name.slice(1)}`;
      const short = f.short ? ` -s ${f.short.slice(1)}` : "";
      const seen = flagNames(f).map((nm) => (nm.startsWith("--") ? `-l ${nm.slice(2)}` : `-s ${nm.slice(1)}`)).join(" ");
      const excl = (f.excludes ?? []).map((e) => `-l ${e.replace(/^--/, "")}`).join(" ");
      const cond = `${at(n.key)}; and not __fish_seen_argument ${seen}${excl ? `; and not __fish_seen_argument ${excl}` : ""}`;
      let tail = "";
      if (f.type === "enum") tail = ` -x -a ${fq((f.values ?? []).join(" "))}`;
      else if (f.type === "dynamic") tail = ` -x -a ${fq(`(loki __complete ${f.dynamic} 2>/dev/null)`)}`;
      else if (f.type === "path") tail = " -r";
      else if (f.type === "string" || f.type === "int") tail = " -x";
      out.push(`complete -c loki -n ${fq(cond)} ${flagArg}${short} -d ${fq(flagHint(f))}${tail}`);
    }
    posSpec(n).filter(Boolean).forEach((spec) => {
      if (spec === "@path") out.push(`complete -c loki -F -n ${fq(at(n.key))}`);
      else if (spec.startsWith("@dyn:")) out.push(`complete -c loki -f -n ${fq(at(n.key))} -a ${fq(`(loki __complete ${spec.slice(5)} 2>/dev/null)`)}`);
      else out.push(`complete -c loki -f -n ${fq(at(n.key))} -a ${fq(spec)}`);
    });
  }
  return out.join("\n") + "\n";
}

export function generate(shell: Shell): string {
  return shell === "bash" ? generateBash() : shell === "zsh" ? generateZsh() : generateFish();
}

// ---------------------------------------------------------------------------
// Dynamic values: `loki __complete <kind>`. Cache reads only, never the network.

const cacheDir = (home: string): string => join(home, ".loki", "cache");

function lines(cmdOut: string): string[] {
  return cmdOut.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function completeKind(kind: string, opts: { home?: string; cwd?: string } = {}): string[] {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  switch (kind as DynKind) {
    case "providers": {
      const dir = join(REPO_ROOT, "providers");
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((f) => f.endsWith(".sh") && !["loader.sh", "models.sh"].includes(f)).map((f) => f.slice(0, -3)).sort();
    }
    case "models": {
      try {
        const cat = JSON.parse(readFileSync(join(REPO_ROOT, "providers", "model_catalog.json"), "utf8")) as { providers: Record<string, { models?: { id?: string; alias?: string }[] }> };
        const out = new Set<string>();
        for (const p of Object.values(cat.providers)) for (const m of p.models ?? []) { if (m.id) out.add(m.id); if (m.alias) out.add(m.alias); }
        return [...out];
      } catch { return []; }
    }
    case "branches": {
      const r = safeGitSpawn(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { encoding: "utf8", timeout: 150 });
      return r.status === 0 ? lines(r.stdout) : [];
    }
    case "runs": {
      const dir = join(cwd, ".loki", "runs");
      try { return readdirSync(dir).filter((f) => !f.startsWith(".")).sort().reverse(); } catch { return []; }
    }
    case "workspaces": {
      try {
        const txt = readFileSync(join(cwd, "loki.yaml"), "utf8").split("\n");
        const out: string[] = [];
        let inWs = false;
        for (const l of txt) {
          if (/^workspaces:\s*$/.test(l)) { inWs = true; continue; }
          if (inWs) { const m = /^ {2}([A-Za-z0-9_.-]+):/.exec(l); if (m) out.push(m[1]!); else if (/^\S/.test(l)) inWs = false; }
        }
        return out;
      } catch { return []; }
    }
    case "issues": {
      const file = join(cacheDir(home), "issues.txt");
      let stale = true;
      try { stale = Date.now() - statSync(file).mtimeMs > 10 * 60 * 1000; } catch { /* missing */ }
      if (stale) refreshIssuesInBackground(file, cwd);
      try { return lines(readFileSync(file, "utf8")); } catch { return []; }
    }
    default:
      return [];
  }
}

function refreshIssuesInBackground(file: string, cwd: string): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    const script = `gh issue list --limit 50 --json number,title --jq '.[] | "#\\(.number)"' > ${JSON.stringify(file + ".tmp")} 2>/dev/null && mv ${JSON.stringify(file + ".tmp")} ${JSON.stringify(file)}`;
    const child = spawn("sh", ["-c", script], { cwd, env: process.env, detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* cache refresh is best effort */ }
}

// ---------------------------------------------------------------------------
// Automatic install. Writes only to locations each shell already auto-loads and
// never edits .zshrc or .bashrc.

export interface InstallOpts {
  home?: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  tty?: boolean; // required true for the first-run path
  requireTty?: boolean;
  fpath?: string[]; // candidate zsh dirs (tests inject; default: well-known dirs)
}
export interface InstallResult {
  status: "skipped" | "installed" | "nolocation" | "current";
  written: string[];
  note?: string;
}

function writable(dir: string): boolean {
  try { accessSync(dir, constants.W_OK); return statSync(dir).isDirectory(); } catch { return false; }
}

export function autoInstall(opts: InstallOpts = {}): InstallResult {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const version = opts.version ?? "unknown";
  try {
    if (env["CI"] || env["LOKI_NO_COMPLETIONS"] === "1") return { status: "skipped", written: [] };
    if (opts.requireTty && !opts.tty) return { status: "skipped", written: [] };
    const stamp = join(home, ".loki", "completions-version");
    try { if (readFileSync(stamp, "utf8").trim() === version) return { status: "current", written: [] }; } catch { /* first time */ }

    const written: string[] = [];
    const put = (path: string, text: string): void => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
      written.push(path);
    };
    put(join(home, ".local", "share", "bash-completion", "completions", "loki"), generateBash());
    if (existsSync(join(home, ".config", "fish"))) put(join(home, ".config", "fish", "completions", "loki.fish"), generateFish());
    const zshDirs = opts.fpath ?? ["/opt/homebrew/share/zsh/site-functions", "/usr/local/share/zsh/site-functions", join(home, ".zfunc")];
    const zdir = zshDirs.find((d) => existsSync(d) && writable(d));
    if (zdir) {
      put(join(zdir, "_loki"), generateZsh());
      try { for (const f of readdirSync(home)) if (f.startsWith(".zcompdump")) unlinkSync(join(home, f)); } catch { /* best effort */ }
    }
    mkdirSync(join(home, ".loki"), { recursive: true });
    writeFileSync(stamp, version + "\n");
    return { status: zdir || written.length ? "installed" : "nolocation", written };
  } catch (e) {
    return { status: "skipped", written: [], note: String(e) };
  }
}
