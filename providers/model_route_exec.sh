#!/usr/bin/env bash
# Exec a command (the claude CLI) with the active model route applied to ITS env
# only. The token is read from the already-inherited env here, so it never
# appears on any command line and is never printed.
# Usage: bash model_route_exec.sh claude [args...]
_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=model_routes.sh
. "$_dir/model_routes.sh"

spec="$(loki_model_route_spec)"
if [ -n "$spec" ] && loki_model_route_parse "$spec"; then
    token=""
    if [ -n "$LOKI_ROUTE_TOKEN_VAR" ]; then
        token="${!LOKI_ROUTE_TOKEN_VAR:-}"
    fi
    export ANTHROPIC_BASE_URL="$LOKI_ROUTE_BASE"
    export ANTHROPIC_MODEL="$LOKI_ROUTE_MODEL"
    export ANTHROPIC_SMALL_FAST_MODEL="$LOKI_ROUTE_MODEL"
    export ANTHROPIC_AUTH_TOKEN="${token:-loki-local-route}"
    export ANTHROPIC_API_KEY=""
fi
exec "$@"
