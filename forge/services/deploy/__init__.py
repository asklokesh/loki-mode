"""Forge deploy - render and promote forge resources to a hosting provider.

F-3 ships Railway only. F-4 adds Fly, Vercel, Cloudflare, local docker-
compose. The contract is the same per provider:

    setup_provider(forge_dir, provider, credentials_ref)
    plan(forge_dir, provider, env)          -> structured deploy plan
    promote(forge_dir, provider, from_env, to_env) -> result + manifest
    status(forge_dir, provider, env)        -> live status

Each provider is implemented by a sibling module. The package routes by
name. The agent never writes raw provider YAML/TOML - it asks the deploy
service to render a plan from the live forge state.
"""

from __future__ import annotations

from .promote import DeployError, plan, promote, status, setup_provider, rollback  # noqa: F401
