"""Email template registry.

Each project can register named templates (e.g. 'magic_link',
'password_reset', 'invoice_failed') with subject + body_text +
body_html fields. The send_template() helper renders them with a
minimal `{key}` substitution and dispatches via send().

Built-in defaults ship for the common transactional templates so a
fresh project gets working emails without any setup.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

from .adapters import send, EmailError


_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,62}$")
_KEY_RE = re.compile(r"\{([a-zA-Z0-9_]+)\}")


DEFAULT_TEMPLATES: Dict[str, Dict[str, str]] = {
    "magic_link": {
        "subject": "Your sign-in link",
        "body_text": "Click to sign in: {link}\n\nExpires in {ttl_minutes} minutes.",
        "body_html": ("<p>Click to sign in:"
                      " <a href=\"{link}\">{link}</a></p>"
                      "<p>Expires in {ttl_minutes} minutes.</p>"),
    },
    "password_reset": {
        "subject": "Reset your password",
        "body_text": "Reset your password: {link}\n\nExpires in {ttl_minutes} minutes.",
        "body_html": ("<p>Reset your password:"
                      " <a href=\"{link}\">{link}</a></p>"),
    },
    "invoice_failed": {
        "subject": "Payment issue on your subscription",
        "body_text": ("Your last payment failed: {invoice_url}\n\n"
                      "Please update your payment method."),
        "body_html": ("<p>Your last payment failed:"
                      " <a href=\"{invoice_url}\">{invoice_url}</a></p>"),
    },
    "welcome": {
        "subject": "Welcome to {product_name}",
        "body_text": "Welcome, {user_name}!\n\nGet started: {dashboard_url}",
        "body_html": ("<p>Welcome, {user_name}!</p>"
                      "<p>Get started: <a href=\"{dashboard_url}\">{dashboard_url}</a></p>"),
    },
}


def _path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "email", "templates.json")


def _load(forge_dir: str) -> Dict[str, Dict[str, str]]:
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return dict(DEFAULT_TEMPLATES)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_TEMPLATES)
    merged = dict(DEFAULT_TEMPLATES)
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, dict):
                merged[k] = {**merged.get(k, {}), **v}
    return merged


def _save(forge_dir: str, overrides: Dict[str, Dict[str, str]]) -> None:
    p = _path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(overrides, f, indent=2, sort_keys=True)
    os.replace(tmp, p)


_LOCALE_RE = __import__("re").compile(r"^[a-z]{2}(-[A-Z]{2})?$")


def register_template(forge_dir: str, name: str, *,
                      subject: str,
                      body_text: str,
                      body_html: Optional[str] = None,
                      locale: Optional[str] = None) -> Dict[str, Any]:
    """X-59: register a transactional email template; optional `locale`
    (e.g. 'en', 'en-US', 'fr', 'de-CH') stores a localized variant.
    Default (locale=None) is the en fallback used when no localization
    matches send_template's locale arg."""
    if not _NAME_RE.match(name or ""):
        raise EmailError(
            "template name must match ^[a-z][a-z0-9_-]{0,62}$"
        )
    if locale is not None and not _LOCALE_RE.match(locale):
        raise EmailError("locale must match ^[a-z]{2}(-[A-Z]{2})?$")
    if not isinstance(subject, str) or not subject:
        raise EmailError("subject required")
    if not isinstance(body_text, str) or not body_text:
        raise EmailError("body_text required")
    # Track only overrides on disk; defaults stay implicit.
    p = _path(forge_dir)
    if os.path.isfile(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                overrides = json.load(f)
        except (OSError, json.JSONDecodeError):
            overrides = {}
    else:
        overrides = {}
    # When a locale is supplied we store under a compound key
    # "<name>@<locale>" so the registry can hold multiple variants
    # per template without churning the default entry.
    key = name if locale is None else f"{name}@{locale}"
    overrides[key] = {
        "subject": subject, "body_text": body_text,
        **({"body_html": body_html} if body_html else {}),
    }
    _save(forge_dir, overrides)
    return {"name": key, **overrides[key]}


def list_templates(forge_dir: str, *,
                   include_defaults: bool = True,
                   name: Optional[str] = None
                   ) -> List[Dict[str, Any]]:
    """N-105: when include_defaults=False, only entries the operator
    has registered (overrides on disk) are returned - the built-in
    DEFAULT_TEMPLATES are excluded so the caller sees just their
    customizations.
    N-164: when `name` is given, return only that template's default
    entry plus its locale variants (`name` and `name@<locale>`)."""
    if include_defaults:
        merged = _load(forge_dir)
        rows = [{"name": k, **v} for k, v in sorted(merged.items())]
    else:
        p = _path(forge_dir)
        rows = []
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    overrides = json.load(f)
                rows = [{"name": k, **v} for k, v in sorted(overrides.items())]
            except (OSError, json.JSONDecodeError):
                rows = []
    if name is not None:
        prefix = f"{name}@"
        rows = [r for r in rows
                if r["name"] == name or r["name"].startswith(prefix)]
    return rows


def unset_template(forge_dir: str, name: str, *,
                   force: bool = False) -> bool:
    """N-60: drop the default entry AND every locale variant in one
    atomic write. Returns True when at least one entry was removed,
    False when no override existed (the built-in default still
    applies in that case).
    N-114: rejects names matching a built-in DEFAULT_TEMPLATES entry
    unless `force=True` so the operator cannot accidentally drop the
    system templates.
    """
    if not _NAME_RE.match(name or ""):
        raise EmailError(
            "template name must match ^[a-z][a-z0-9_-]{0,62}$"
        )
    if not force and name in DEFAULT_TEMPLATES:
        raise EmailError(
            f"refusing to drop built-in default {name!r}; "
            "pass force=True to override"
        )
    # N-133: when force-dropping a built-in default, leave an audit
    # trail so operators can correlate later "where did the welcome
    # email go?" questions with the action that caused it.
    if force and name in DEFAULT_TEMPLATES:
        try:
            import time as _t
            audit_p = os.path.join(forge_dir, "email", "dropped_defaults.jsonl")
            os.makedirs(os.path.dirname(audit_p), exist_ok=True)
            with open(audit_p, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "name": name, "ts": int(_t.time()), "forced": True,
                }) + "\n")
        except OSError:
            pass
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return False
    try:
        with open(p, "r", encoding="utf-8") as f:
            overrides = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    removed = False
    if name in overrides:
        del overrides[name]
        removed = True
    prefix = f"{name}@"
    for key in list(overrides.keys()):
        if key.startswith(prefix):
            del overrides[key]
            removed = True
    if removed:
        _save(forge_dir, overrides)
    return removed


def list_dropped_defaults(forge_dir: str, *,
                          since_ts: Optional[int] = None
                          ) -> List[Dict[str, Any]]:
    """N-143: parsed dropped_defaults.jsonl. Dashboards use this to
    show which built-ins were force-dropped (and when).
    N-153: optional since_ts filter returns drops newer than the
    epoch second."""
    p = os.path.join(forge_dir, "email", "dropped_defaults.jsonl")
    if not os.path.isfile(p):
        return []
    out: List[Dict[str, Any]] = []
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    if since_ts is not None:
        out = [r for r in out
               if isinstance(r.get("ts"), int) and r["ts"] >= int(since_ts)]
    return out


def is_default(name: str) -> bool:
    """N-124: True when `name` is shipped as a built-in default
    template. Callers can use this to surface a warning before
    invoking unset_template(force=True)."""
    return name in DEFAULT_TEMPLATES


def clear_locales(forge_dir: str, name: str) -> List[str]:
    """N-25: drop every localized variant for `name` in one call.
    The default (locale=None) entry is preserved. Returns the list
    of locales that were removed so the caller can log them.
    """
    if not _NAME_RE.match(name or ""):
        raise EmailError(
            "template name must match ^[a-z][a-z0-9_-]{0,62}$"
        )
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            overrides = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    prefix = f"{name}@"
    removed = []
    for key in list(overrides.keys()):
        if key.startswith(prefix):
            removed.append(key[len(prefix):])
            del overrides[key]
    if removed:
        _save(forge_dir, overrides)
    return removed


def unset_locale(forge_dir: str, name: str, locale: str) -> bool:
    """N-11: drop a localized variant of a template without touching
    the default (locale=None) entry. Returns True when a variant was
    removed, False when no matching variant existed. Refuses to drop
    the default by raising EmailError if `locale` is None - operators
    should call delete logic intentionally for that.
    """
    if locale is None:
        raise EmailError(
            "unset_locale refuses to drop the default; pass an "
            "explicit locale like 'en' or 'fr-CA'"
        )
    if not _NAME_RE.match(name or ""):
        raise EmailError(
            "template name must match ^[a-z][a-z0-9_-]{0,62}$"
        )
    if not _LOCALE_RE.match(locale):
        raise EmailError("locale must match ^[a-z]{2}(-[A-Z]{2})?$")
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return False
    try:
        with open(p, "r", encoding="utf-8") as f:
            overrides = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    key = f"{name}@{locale}"
    if key not in overrides:
        return False
    del overrides[key]
    _save(forge_dir, overrides)
    return True


def _render(tmpl: str, ctx: Dict[str, Any]) -> str:
    def repl(m):
        key = m.group(1)
        v = ctx.get(key)
        return "" if v is None else str(v)
    return _KEY_RE.sub(repl, tmpl)


def send_template(forge_dir: str, provider: str, *,
                  template: str, to: str,
                  context: Optional[Dict[str, Any]] = None,
                  locale: Optional[str] = None) -> Dict[str, Any]:
    """X-59: send a transactional email by template name. Optional
    `locale` resolves to <template>@<locale> first, then falls back
    to <template>@<language-only>, then to the unlocalized default."""
    db = _load(forge_dir)
    tmpl = None
    if locale:
        tmpl = db.get(f"{template}@{locale}")
        if tmpl is None and "-" in locale:
            tmpl = db.get(f"{template}@{locale.split('-')[0]}")
    if tmpl is None:
        tmpl = db.get(template)
    if tmpl is None:
        raise EmailError(f"template not found: {template}")
    ctx = context or {}
    subject = _render(tmpl["subject"], ctx)
    body_text = _render(tmpl["body_text"], ctx)
    body_html = _render(tmpl["body_html"], ctx) if tmpl.get("body_html") else None
    return send(forge_dir, provider, to=to, subject=subject,
                body_text=body_text, body_html=body_html)
