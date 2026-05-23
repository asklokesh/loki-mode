"""OAuth + magic-link + WebAuthn provider configuration.

In F-2 we ship the *config storage* and PKCE-flow URL generators. Full
callback handling lives in dashboard/forge_router.py (F-2.27). The
intent is that the agent can call forge_auth_provider_add(name, config)
during the RARV loop and the user's app picks up working sign-in URLs
the next iteration.
"""

from __future__ import annotations

import json
import os
import secrets
import urllib.parse
from typing import Any, Dict, List, Optional


# Each provider entry is (name, default_auth_endpoint, default_token_endpoint,
# default_scopes). The agent supplies client_id + client_secret via secrets;
# config files only ever store references, never raw secrets in clear.
SUPPORTED_PROVIDERS: Dict[str, Dict[str, Any]] = {
    "google": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://openidconnect.googleapis.com/v1/userinfo",
        "scopes": ["openid", "email", "profile"],
    },
    "github": {
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "userinfo_url": "https://api.github.com/user",
        "scopes": ["read:user", "user:email"],
    },
    "apple": {
        "authorize_url": "https://appleid.apple.com/auth/authorize",
        "token_url": "https://appleid.apple.com/auth/token",
        "scopes": ["name", "email"],
    },
    "microsoft": {
        "authorize_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "token_url": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "userinfo_url": "https://graph.microsoft.com/oidc/userinfo",
        "scopes": ["openid", "email", "profile"],
    },
    "gitlab": {
        "authorize_url": "https://gitlab.com/oauth/authorize",
        "token_url": "https://gitlab.com/oauth/token",
        "userinfo_url": "https://gitlab.com/api/v4/user",
        "scopes": ["openid", "profile", "email"],
    },
    "discord": {
        "authorize_url": "https://discord.com/api/oauth2/authorize",
        "token_url": "https://discord.com/api/oauth2/token",
        "userinfo_url": "https://discord.com/api/users/@me",
        "scopes": ["identify", "email"],
    },
    "slack": {
        "authorize_url": "https://slack.com/openid/connect/authorize",
        "token_url": "https://slack.com/api/openid.connect.token",
        "userinfo_url": "https://slack.com/api/openid.connect.userInfo",
        "scopes": ["openid", "email", "profile"],
    },
    # Local/passwordless flows.
    "email-password": {"local": True},
    "magic-link": {"local": True},
    "webauthn": {"local": True},
}


def _providers_dir(forge_dir: str) -> str:
    return os.path.join(forge_dir, "auth", "providers")


def add_provider(forge_dir: str, name: str,
                 config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Register an auth provider. config may carry client_id, redirect_uri,
    plus *references* to secrets (e.g. {"client_secret_ref":
    "GOOGLE_CLIENT_SECRET"}). Raw secrets in config are rejected to keep
    the on-disk file safe to commit (it never should be, but defense in
    depth)."""
    if name not in SUPPORTED_PROVIDERS:
        raise ValueError(f"unsupported provider: {name}")
    config = dict(config or {})

    # Defense: reject obvious raw-secret keys.
    for k in list(config.keys()):
        if k.lower() in ("client_secret", "private_key", "api_key", "secret",
                         "shared_secret"):
            raise ValueError(
                f"raw secret '{k}' must not be stored in provider config; "
                "use forge_secret_set then reference via <key>_ref"
            )

    # Merge with defaults.
    merged = {**SUPPORTED_PROVIDERS[name], **config}
    merged["_provider"] = name

    pdir = _providers_dir(forge_dir)
    os.makedirs(pdir, exist_ok=True)
    path = os.path.join(pdir, f"{name}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2, sort_keys=True)
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    return {"provider": name, "path": path, "config": merged}


def remove_provider(forge_dir: str, name: str) -> bool:
    """Unregister a provider. Returns True if a file was removed."""
    if name not in SUPPORTED_PROVIDERS:
        raise ValueError(f"unsupported provider: {name}")
    path = os.path.join(_providers_dir(forge_dir), f"{name}.json")
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def list_providers(forge_dir: str) -> List[Dict[str, Any]]:
    """Return the currently registered providers and their non-secret config."""
    pdir = _providers_dir(forge_dir)
    if not os.path.isdir(pdir):
        return []
    out = []
    for entry in sorted(os.listdir(pdir)):
        if not entry.endswith(".json"):
            continue
        try:
            with open(os.path.join(pdir, entry), "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        out.append(cfg)
    return out


def authorize_url(forge_dir: str, name: str, redirect_uri: str,
                  state: Optional[str] = None,
                  scopes: Optional[List[str]] = None) -> Dict[str, str]:
    """Build the provider's authorize URL with PKCE. Returns the URL plus
    the code_verifier the user-app must keep until the callback so it
    can complete the token exchange."""
    if name not in SUPPORTED_PROVIDERS:
        raise ValueError(f"unsupported provider: {name}")
    cfg_path = os.path.join(_providers_dir(forge_dir), f"{name}.json")
    if not os.path.exists(cfg_path):
        raise ValueError(f"provider not configured: {name} (call add_provider first)")
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    if cfg.get("local"):
        raise ValueError(f"provider {name} is local-only (no authorize URL)")
    if not cfg.get("client_id"):
        raise ValueError(f"provider {name} missing client_id; re-run add_provider")

    code_verifier = secrets.token_urlsafe(64)
    # PKCE S256 challenge.
    import hashlib as _hashlib
    import base64 as _base64
    challenge_bytes = _hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = _base64.urlsafe_b64encode(challenge_bytes).rstrip(b"=").decode("ascii")

    params = {
        "response_type": "code",
        "client_id": cfg["client_id"],
        "redirect_uri": redirect_uri,
        "scope": " ".join(scopes or cfg.get("scopes") or []),
        "state": state or secrets.token_urlsafe(16),
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    url = cfg["authorize_url"] + "?" + urllib.parse.urlencode(params)
    return {"authorize_url": url, "code_verifier": code_verifier,
            "state": params["state"]}
