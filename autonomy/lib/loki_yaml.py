#!/usr/bin/env python3
"""loki.yaml: lookup, env overrides and validation (D51).

Shared by `loki backlog`, `loki config validate` and the dashboard.
Single source of truth for the key set: schemas/loki-yaml.schema.json.

    from loki_yaml import load
    cfg, path, errors = load()

CLI:
    loki_yaml.py validate [FILE]    rc 0 ok, 1 invalid or none found, 2 cannot check
    loki_yaml.py show               effective config as JSON (env overrides applied)

Never echoes a string value for an x-secret-ref field: a user who pastes a real
token into token_env must not see it printed back.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, "..", "..", "schemas", "loki-yaml.schema.json")

# dotted key -> env var (CLI flag > env > loki.yaml > default)
ENV_OVERRIDES = {
    "provider": "LOKI_PROVIDER",
    "models.default": "LOKI_MODEL_DEVELOPMENT",
    "models.cheap": "LOKI_MODEL_FAST",
    "git.token_env": "LOKI_GIT_TOKEN_ENV",
    "concurrency": "LOKI_BACKLOG_CONCURRENCY",
    "budgets.per_run_usd": "LOKI_BUDGET_PER_RUN_USD",
    "budgets.per_day_usd": "LOKI_BUDGET_PER_DAY_USD",
    "notifications.slack_webhook_env": "LOKI_SLACK_WEBHOOK_ENV",
}


class CannotCheck(Exception):
    """No usable YAML parser: callers must not read this as 'valid'."""


def load_schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def find_config(cwd=None, home=None):
    """Repo-root loki.yaml first, else ~/.loki/loki.yaml. First found wins."""
    cwd = cwd or os.getcwd()
    home = home or os.path.expanduser("~")
    try:
        top = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True).stdout.strip()
    except OSError:
        top = ""
    for cand in (os.path.join(top or cwd, "loki.yaml"),
                 os.path.join(home, ".loki", "loki.yaml")):
        if os.path.isfile(cand):
            return cand
    return None


def parse_yaml(path):
    try:
        import yaml
        with open(path) as f:
            return yaml.safe_load(f)
    except ImportError:
        pass
    try:
        r = subprocess.run(["yq", "eval", "-o=json", ".", path], capture_output=True, text=True)
    except OSError:
        raise CannotCheck("no YAML parser: install PyYAML (pip install pyyaml) or yq")
    if r.returncode != 0:
        raise ValueError("invalid YAML: " + (r.stderr.strip().splitlines() or ["parse error"])[0])
    return json.loads(r.stdout)


def _type_ok(val, t):
    if t == "object":
        return isinstance(val, dict)
    if t == "array":
        return isinstance(val, list)
    if t == "string":
        return isinstance(val, str)
    if t == "integer":
        return isinstance(val, int) and not isinstance(val, bool)
    if t == "number":
        return isinstance(val, (int, float)) and not isinstance(val, bool)
    return True


def validate(data, schema, path="", out=None):
    """Validate against the JSON-schema subset used by loki-yaml.schema.json."""
    import re
    out = [] if out is None else out
    label = path or "(top level)"
    t = schema.get("type")
    secret = schema.get("x-secret-ref")
    shown = "" if secret or not isinstance(data, (str, int, float)) else " (got %r)" % (data,)
    if t and not _type_ok(data, t):
        out.append("%s: must be %s%s" % (label, {"integer": "an integer", "object": "a mapping",
                   "array": "a list", "string": "a string", "number": "a number"}[t], shown))
        return out
    if isinstance(data, dict):
        props = schema.get("properties", {})
        for k, v in data.items():
            kp = (path + "." if path else "") + str(k)
            if k not in props:
                if schema.get("additionalProperties") is False:
                    out.append("%s: unknown key (allowed: %s)" % (kp, ", ".join(sorted(props))))
            else:
                validate(v, props[k], kp, out)
    elif isinstance(data, list):
        for i, v in enumerate(data):
            validate(v, schema.get("items", {}), "%s[%d]" % (path, i), out)
    elif isinstance(data, str):
        if secret and not re.match(schema.get("pattern", ""), data):
            out.append("%s: must be the NAME of an environment variable (UPPER_CASE letters, "
                       "digits, underscore), not the secret itself" % label)
        elif "pattern" in schema and not re.match(schema["pattern"], data):
            out.append("%s: does not match %s%s" % (label, schema["pattern"], shown))
        elif "enum" in schema and data not in schema["enum"]:
            out.append("%s: must be one of %s%s" % (label, ", ".join(schema["enum"]), shown))
        elif len(data) < schema.get("minLength", 0):
            out.append("%s: must not be empty" % label)
    if _type_ok(data, "number") and not isinstance(data, bool):
        if "minimum" in schema and data < schema["minimum"]:
            out.append("%s: must be >= %s%s" % (label, schema["minimum"], shown))
        elif "maximum" in schema and data > schema["maximum"]:
            out.append("%s: must be <= %s%s" % (label, schema["maximum"], shown))
        elif "exclusiveMinimum" in schema and data <= schema["exclusiveMinimum"]:
            out.append("%s: must be > %s%s" % (label, schema["exclusiveMinimum"], shown))
    return out


def _schema_type(schema, dotted):
    for part in dotted.split("."):
        schema = schema["properties"][part]
    return schema.get("type")


def apply_env(cfg, schema, env):
    """Overlay env overrides onto cfg. Returns {dotted_key: env_var} of what was applied."""
    applied = {}
    for dotted, var in ENV_OVERRIDES.items():
        raw = env.get(var)
        if raw is None or raw == "":
            continue
        val = raw
        t = _schema_type(schema, dotted)
        try:
            if t == "integer":
                val = int(raw)
            elif t == "number":
                val = float(raw)
        except ValueError:
            pass  # stays a string; validation reports it, naming the env var
        node = cfg
        parts = dotted.split(".")
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = val
        applied[dotted] = var
    return applied


def load(cwd=None, env=None, home=None, path=None):
    """Return (cfg, path_or_None, errors). Raises CannotCheck when YAML cannot be parsed."""
    env = os.environ if env is None else env
    schema = load_schema()
    path = path or find_config(cwd, home)
    cfg, errors = {}, []
    if path:
        try:
            data = parse_yaml(path)
        except CannotCheck:
            raise
        except Exception as e:
            return {}, path, ["%s: %s" % (path, e)]
        if data is None:
            data = {}
        if not isinstance(data, dict):
            return {}, path, ["%s: top level must be a mapping" % path]
        cfg = data
    applied = apply_env(cfg, schema, env)
    for e in validate(cfg, schema):
        key = e.split(":", 1)[0]
        if key in applied:
            e = e.replace(key + ":", "%s (from env %s):" % (key, applied[key]), 1)
        errors.append(e)
    return cfg, path, errors


def main(argv):
    cmd = argv[0] if argv else ""
    if cmd not in ("validate", "show"):
        print("usage: loki_yaml.py validate [FILE] | show", file=sys.stderr)
        return 2
    explicit = argv[1] if cmd == "validate" and len(argv) > 1 else None
    if explicit and not os.path.isfile(explicit):
        print("loki: config validate: file not found: %s" % explicit, file=sys.stderr)
        return 1
    try:
        cfg, path, errors = load(path=explicit)
    except CannotCheck as e:
        print("loki: config validate: could not check: %s" % e, file=sys.stderr)
        return 2
    if cmd == "show":
        print(json.dumps({"path": path, "config": cfg, "errors": errors}, indent=2))
        return 1 if errors else 0
    if path is None and not errors:
        print("loki: no loki.yaml found (looked in the repo root and ~/.loki/loki.yaml)", file=sys.stderr)
        return 1
    if errors:
        print("INVALID: %s" % (path or "environment overrides"))
        for e in errors:
            print("  - " + e)
        return 1
    print("OK: %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
