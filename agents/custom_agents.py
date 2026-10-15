#!/usr/bin/env python3
"""User-configurable child agents: .loki/agents/<name>.md and ~/.config/loki/agents/<name>.md.

Markdown with simple YAML frontmatter (name, description, model, provider, tools,
deny, permission). Body is the system prompt. Project definitions override user ones.
Stdlib only. CLI: list | new | show | export | resolve.
"""
import json
import os
import re
import sys

PERMISSIONS = ("plan", "edit", "full")
KEYS = ("name", "description", "model", "provider", "tools", "deny", "permission")
LIST_KEYS = ("tools", "deny")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
PROVIDERS = ("claude", "codex", "cline", "aider", "opencode")
# Tools a plan-permission agent must not use when exported to Claude Code.
PLAN_DENY = ["Edit", "Write", "NotebookEdit", "Bash"]


class AgentError(Exception):
    pass


def project_dir():
    return os.environ.get("LOKI_AGENTS_PROJECT_DIR") or os.path.join(os.getcwd(), ".loki", "agents")


def user_dir():
    d = os.environ.get("LOKI_AGENTS_USER_DIR")
    if d:
        return d
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "loki", "agents")


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def _parse_list(v):
    v = v.strip()
    if v.startswith("[") and v.endswith("]"):
        v = v[1:-1]
    return [_unquote(x) for x in v.split(",") if x.strip()]


def parse(text, path="<agent>"):
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise AgentError("%s: missing YAML frontmatter (file must start with '---')" % path)
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        raise AgentError("%s: frontmatter is not closed with '---'" % path)
    meta = {}
    cur = None
    for n, raw in enumerate(lines[1:end], start=2):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = re.match(r"^\s+-\s+(.*)$", raw)
        if m and cur in LIST_KEYS:
            meta.setdefault(cur, []).append(_unquote(m.group(1)))
            continue
        m = re.match(r"^([A-Za-z_]+)\s*:\s*(.*)$", raw)
        if not m:
            raise AgentError("%s:%d: cannot parse frontmatter line: %r" % (path, n, raw))
        k, v = m.group(1).lower(), m.group(2)
        if k not in KEYS:
            raise AgentError("%s:%d: unknown key %r (allowed: %s)" % (path, n, k, ", ".join(KEYS)))
        cur = k
        if k in LIST_KEYS:
            meta[k] = _parse_list(v) if v.strip() else []
        else:
            meta[k] = _unquote(v)
    body = "\n".join(lines[end + 1:]).strip()
    return meta, body


def validate(meta, body, path, stem):
    name = meta.get("name") or stem
    if not NAME_RE.match(name):
        raise AgentError("%s: invalid name %r (use lowercase letters, digits, '-' or '_')" % (path, name))
    if name != stem:
        raise AgentError("%s: name %r does not match file name %r" % (path, name, stem))
    if not meta.get("description"):
        raise AgentError("%s: 'description' is required" % path)
    perm = meta.get("permission", "plan")
    if perm not in PERMISSIONS:
        raise AgentError("%s: permission must be one of %s (got %r)" % (path, "|".join(PERMISSIONS), perm))
    prov = meta.get("provider", "claude")
    if prov not in PROVIDERS:
        raise AgentError("%s: provider must be one of %s (got %r)" % (path, "|".join(PROVIDERS), prov))
    if not body:
        raise AgentError("%s: body (system prompt) is empty" % path)
    both = set(meta.get("tools", [])) & set(meta.get("deny", []))
    if both:
        raise AgentError("%s: tool(s) in both tools and deny: %s" % (path, ", ".join(sorted(both))))
    return {
        "name": name,
        "description": meta["description"],
        "model": meta.get("model", ""),
        "provider": prov,
        "tools": meta.get("tools", []),
        "deny": meta.get("deny", []),
        "permission": perm,
        "prompt": body,
        "path": path,
    }


def load_file(path):
    stem = os.path.basename(path)[:-3]
    with open(path, encoding="utf-8") as f:
        meta, body = parse(f.read(), path)
    return validate(meta, body, path, stem)


def load_all():
    """Return (agents dict name->agent, errors list). Project overrides user."""
    agents, errors = {}, []
    for scope, d in (("user", user_dir()), ("project", project_dir())):
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".md") or fn.startswith("."):
                continue
            p = os.path.join(d, fn)
            try:
                a = load_file(p)
                a["scope"] = scope
                agents[a["name"]] = a
            except (AgentError, OSError, UnicodeDecodeError) as e:
                errors.append(str(e))
    return agents, errors


TEMPLATE = """---
name: {name}
description: One line describing when to use this agent
model: sonnet
provider: claude
permission: plan
tools: [Read, Grep, Glob]
deny: []
---
You are the {name} agent. Describe your role, method and output format here.
"""


def cmd_new(name, user=False):
    if not NAME_RE.match(name or ""):
        raise AgentError("invalid agent name %r (lowercase letters, digits, '-' or '_')" % name)
    d = user_dir() if user else project_dir()
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, name + ".md")
    if os.path.exists(p):
        raise AgentError("already exists: %s" % p)
    shipped = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates", "agents", name + ".md")
    if os.path.isfile(shipped):
        with open(shipped, encoding="utf-8") as src:
            content = src.read()
    else:
        content = TEMPLATE.format(name=name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    print("Created %s" % p)


def claude_export(a):
    lines = ["---", "name: %s" % a["name"], "description: %s" % a["description"]]
    if a["model"] and a["provider"] == "claude":
        lines.append("model: %s" % a["model"])
    tools = list(a["tools"])
    if tools:
        lines.append("tools: %s" % ", ".join(tools))
    deny = list(a["deny"])
    if a["permission"] == "plan":
        deny += [t for t in PLAN_DENY if t not in deny and t not in tools]
    if deny:
        lines.append("disallowedTools: %s" % ", ".join(deny))
    lines += ["---", a["prompt"], ""]
    return "\n".join(lines)


ALIASES = {
    "code_quality_reviewer": ["reviewer"],
    "requirements_verifier": ["reviewer"],
    "test_auditor": ["tester", "reviewer"],
    "devils_advocate": ["security", "reviewer"],
}


def resolve(role):
    """Pick a configured agent for a council role: exact name, then aliases."""
    agents, _ = load_all()
    for cand in [role] + ALIASES.get(role, []):
        for k in (cand, cand.replace("_", "-")):
            if k in agents:
                return agents[k]
    return None


def main(argv):
    cmd = argv[0] if argv else "list"
    rest = argv[1:]
    try:
        if cmd == "list":
            agents, errors = load_all()
            if not agents:
                print("No configured agents. Create one with: loki agents new <name>")
            else:
                print("%-16s %-8s %-8s %-6s %s" % ("NAME", "SCOPE", "PROVIDER", "PERM", "DESCRIPTION"))
                for n in sorted(agents):
                    a = agents[n]
                    print("%-16s %-8s %-8s %-6s %s" % (n, a["scope"], a["provider"], a["permission"], a["description"]))
            for e in errors:
                sys.stderr.write("invalid agent: %s\n" % e)
            return 1 if errors else 0
        if cmd == "new":
            names = [x for x in rest if not x.startswith("--")]
            if not names:
                raise AgentError("usage: loki agents new <name> [--user]")
            cmd_new(names[0], "--user" in rest)
            return 0
        if cmd == "show":
            if not rest:
                raise AgentError("usage: loki agents show <name>")
            agents, errors = load_all()
            a = agents.get(rest[0])
            if not a:
                for e in errors:
                    sys.stderr.write("invalid agent: %s\n" % e)
                raise AgentError("agent not found: %s (see: loki agents list)" % rest[0])
            for k in ("name", "scope", "path", "description", "provider", "model", "permission", "tools", "deny"):
                v = a[k]
                print("%-12s %s" % (k + ":", ", ".join(v) if isinstance(v, list) else (v or "(default)")))
            print("\n" + a["prompt"])
            return 0
        if cmd == "export":
            if "--claude" not in rest:
                raise AgentError("usage: loki agents export --claude [--user]")
            agents, errors = load_all()
            for e in errors:
                sys.stderr.write("invalid agent: %s\n" % e)
            if not agents:
                raise AgentError("no configured agents to export")
            if "--user" in rest:
                out = os.path.expanduser("~/.claude/agents")
            else:
                out = os.path.join(os.getcwd(), ".claude", "agents")
            os.makedirs(out, exist_ok=True)
            for n in sorted(agents):
                p = os.path.join(out, n + ".md")
                with open(p, "w", encoding="utf-8") as f:
                    f.write(claude_export(agents[n]))
                print("Wrote %s" % p)
            return 1 if errors else 0
        if cmd == "resolve":
            a = resolve(rest[0]) if rest else None
            if a:
                print(json.dumps({"name": a["name"], "model": a["model"], "provider": a["provider"],
                                  "permission": a["permission"], "deny": a["deny"], "prompt": a["prompt"]}))
            return 0
        raise AgentError("unknown subcommand %r (list|new|show|export)" % cmd)
    except AgentError as e:
        sys.stderr.write("Error: %s\n" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
