#!/usr/bin/env bash
# quickstart.sh -- guided first-build interview (v7.29.0, design feature 3).
#
# `loki quickstart` is a thin orchestrator over three already-shipped pieces:
#   1. the provider install offer (autonomy/provider-offer.sh, slice B)
#   2. the honest cost estimator (show_prd_plan in autonomy/loki, slice A)
#   3. cmd_start (autonomy/loki) for the actual build
# plus one new, deterministic, offline keyword matcher over templates/.
#
# It NEVER reimplements the runner and NEVER fabricates a number: every figure
# in step 4 comes from the same estimator cmd_start will run with, so the quote
# equals the charge by construction (the slice-A honesty keystone).
#
# Sourcing contract (load-bearing for tests): this file defines functions ONLY.
# It runs no top-level command and never calls `main`. autonomy/loki sources it
# near the top so cmd_quickstart and its helpers are in scope for the dispatch
# case. Tests source it directly, override the _qs_non_interactive predicate, and
# stub cmd_start / provider_offer_gate to prove the composition without spending
# or starting a build. Because it is sourced (not a subprocess), it relies on the
# caller (autonomy/loki) for SKILL_DIR, the color vars, show_prd_plan,
# provider_offer_gate, and cmd_start; the test harness provides stubs for those
# it does not exercise for real.

# Guard against double-source.
if [ -n "${_LOKI_QUICKSTART_SOURCED:-}" ]; then
    return 0 2>/dev/null || true
fi
_LOKI_QUICKSTART_SOURCED=1

# --- Self-contained colors (ANSI-interpreted, _QS_-prefixed) ---------------
# autonomy/loki's own BOLD/RED/etc. hold LITERAL "\033[..." strings meant for
# `echo -e`; this file uses printf, so it defines its OWN $'...'-interpreted
# vars (the provider-offer.sh pattern). They are _QS_-prefixed so sourcing this
# file never clobbers loki's color globals (the rest of the CLI uses echo -e).
# Honors NO_COLOR and non-TTY.
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
    _QS_BOLD=''; _QS_DIM=''; _QS_CYAN=''; _QS_YELLOW=''; _QS_RED=''; _QS_NC=''
else
    _QS_BOLD=$'\033[1m'
    _QS_DIM=$'\033[2m'
    _QS_CYAN=$'\033[0;36m'
    _QS_YELLOW=$'\033[1;33m'
    _QS_RED=$'\033[0;31m'
    _QS_NC=$'\033[0m'
fi

# _qs_templates_dir: resolve the templates directory. Prefers SKILL_DIR (set by
# autonomy/loki); falls back to this script's sibling templates/ for tests.
_qs_templates_dir() {
    if [ -n "${SKILL_DIR:-}" ] && [ -d "${SKILL_DIR}/templates" ]; then
        printf '%s\n' "${SKILL_DIR}/templates"
        return 0
    fi
    local self_dir
    self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    printf '%s\n' "$(cd "$self_dir/.." && pwd)/templates"
}

# _qs_non_interactive: true (0) when we must NEVER prompt (non-TTY or CI).
# Named (not inlined) so tests can override it to drive the interview without a
# real terminal. Mirrors provider-offer.sh's _po_non_interactive idiom.
_qs_non_interactive() {
    [ ! -t 0 ] && return 0
    [ ! -t 1 ] && return 0
    [ -n "${CI:-}" ] && return 0
    return 1
}

# _qs_assume_yes: true when the user opted into auto-confirm (--yes /
# LOKI_ASSUME_YES / the LOKI_AUTO_CONFIRM that --yes already sets at loki:1013).
_qs_assume_yes() {
    [ "${LOKI_ASSUME_YES:-}" = "1" ] && return 0
    [ "${LOKI_ASSUME_YES:-}" = "true" ] && return 0
    [ "${LOKI_AUTO_CONFIRM:-}" = "true" ] && return 0
    return 1
}

# _qs_keyword_map: curated keyword -> template -> weight table (design 3.5).
# Format per line: keyword:template:weight. Deterministic, offline, no LLM.
# A template's own flagship term carries a higher weight so the head noun wins
# (e.g. "todo" -> simple-todo-app outranks incidental account/user matches).
_qs_keyword_map() {
cat <<'MAP'
todo:simple-todo-app:5
list:simple-todo-app:3
auth:rest-api-auth:3
auth:saas-starter:3
login:rest-api-auth:3
login:saas-starter:3
account:saas-starter:4
accounts:saas-starter:4
account:rest-api-auth:3
accounts:rest-api-auth:3
user:saas-starter:3
users:saas-starter:3
user:rest-api-auth:2
users:rest-api-auth:2
signup:saas-starter:3
tenant:saas-starter:3
saas:saas-starter:3
subscription:saas-starter:3
billing:saas-starter:3
api:rest-api:3
api:api-only:3
endpoint:rest-api:3
endpoints:rest-api:3
rest:rest-api:3
backend:rest-api:3
bot:discord-bot:3
bot:slack-bot:3
discord:discord-bot:3
slack:slack-bot:3
chat:ai-chatbot:3
chatbot:ai-chatbot:3
ai:ai-chatbot:3
llm:ai-chatbot:3
shop:e-commerce:3
store:e-commerce:3
ecommerce:e-commerce:3
commerce:e-commerce:3
cart:e-commerce:3
blog:blog-platform:3
cms:blog-platform:3
post:blog-platform:3
posts:blog-platform:3
dashboard:dashboard:3
analytics:dashboard:3
admin:dashboard:3
cli:cli-tool:3
terminal:cli-tool:3
command:cli-tool:3
game:game:3
play:game:3
mobile:mobile-app:3
ios:mobile-app:3
android:mobile-app:3
scraper:web-scraper:3
scrape:web-scraper:3
crawl:web-scraper:3
pipeline:data-pipeline:3
etl:data-pipeline:3
data:data-pipeline:3
microservice:microservice:3
service:microservice:3
library:npm-library:3
package:npm-library:3
npm:npm-library:3
extension:chrome-extension:3
chrome:chrome-extension:3
browser:chrome-extension:3
landing:static-landing-page:3
static:static-landing-page:3
marketing:static-landing-page:3
fullstack:full-stack-demo:3
MAP
}

# _qs_is_stopword: filter generic words that would add filename-token noise
# (e.g. "app" matching mobile-app for every brief). Returns 0 for a stopword.
_qs_is_stopword() {
    case "$1" in
        a|an|the|my|your|our|with|for|and|to|of|in|on|app|application|build|make|create|want|that|this|some|simple) return 0;;
    esac
    return 1
}

# _qs_score_templates <brief>: print the top-3 closest templates, one name per
# line, in deterministic rank order. simple-todo-app is the guaranteed default:
# it gets a +1 baseline and wins exact-score ties (priority column in the sort).
# Scoring: +2 per non-stopword token that matches a template filename token,
# plus the curated keyword weights. No network, no provider, no LLM.
_qs_score_templates() {
    local brief="$1"
    local tdir; tdir="$(_qs_templates_dir)"
    local brief_lc; brief_lc=$(printf '%s' "$brief" | tr '[:upper:]' '[:lower:]')

    # BASH 3.2 COMPATIBLE. This used `declare -A scores`, a bash 4 associative
    # array. macOS ships bash 3.2.57 as /bin/bash (frozen since 2007, GPLv2,
    # and Apple will not update it), so on the stock shell of the most common
    # developer platform this function printed
    #     declare: -A: invalid option
    # and returned ZERO templates. The function body parses fine, which is why
    # sourcing looked healthy and the failure only appeared when CALLED --
    # and the test harness runs under homebrew bash 5, so nothing caught it.
    # `loki quickstart` is the guided first build we point new users at, so
    # this was a first-run failure on Macs.
    #
    # Scores are kept in a flat "name<TAB>score" list instead. Same semantics,
    # portable to 3.2, and the final sort was already doing the ordering work.
    local scores=""
    local name f
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        name=$(basename "$f" .md)
        [ "$name" = "README" ] && continue
        scores="${scores}${name}\t0\n"
    done < <(ls "$tdir"/*.md 2>/dev/null)

    # No templates resolvable: fall back to the guaranteed default only.
    if [ -z "$scores" ]; then
        printf 'simple-todo-app\n'
        return 0
    fi

    local -a tokens
    read -ra tokens <<< "$(printf '%s' "$brief_lc" | tr -cs 'a-z0-9' ' ')"

    # Build the additive score deltas, then fold them in once with awk. Doing
    # the arithmetic in awk rather than a bash re-write loop keeps this O(n) and
    # avoids quoting a growing string repeatedly.
    local deltas="" tok kw tmpl wt
    for tok in "${tokens[@]}"; do
        [ -z "$tok" ] && continue
        _qs_is_stopword "$tok" && continue
        # +2 per template whose hyphenated name contains the token.
        while IFS=$'\t' read -r name _; do
            [ -z "$name" ] && continue
            case "-$name-" in
                *"-$tok-"*) deltas="${deltas}${name}\t2\n";;
            esac
        done < <(printf '%b' "$scores")
        # Curated keyword weights.
        while IFS=: read -r kw tmpl wt; do
            [ -z "$kw" ] && continue
            [ -z "$wt" ] && wt=3
            if [ "$tok" = "$kw" ]; then
                deltas="${deltas}${tmpl}\t${wt}\n"
            fi
        done < <(_qs_keyword_map)
    done

    # Guaranteed default baseline: simple-todo-app gets +1 and wins exact ties.
    deltas="${deltas}simple-todo-app\t1\n"

    # Fold: keep only names that are REAL templates (a keyword map entry naming
    # a template that does not exist must not invent one), sum the deltas, then
    # sort by score desc, priority asc (simple-todo-app=0 wins ties), name asc.
    printf '%b' "$scores" > /dev/null  # (no-op guard: scores is always non-empty here)
    {
        printf '%b' "$scores"
        printf '%b' "$deltas"
    } | awk -F'\t' '
        NF < 2 { next }
        # First pass marker: names present in the base list are valid templates.
        { sum[$1] += $2; if (!($1 in seen) && $2 == 0) seen[$1] = 1 }
        END {
            for (n in sum) {
                if (!(n in seen)) continue
                prio = (n == "simple-todo-app") ? 0 : 1
                printf "%d\t%d\t%s\n", sum[n], prio, n
            }
        }
    ' | sort -t"$(printf '\t')" -k1,1nr -k2,2n -k3,3 | head -3 | cut -f3
}

# _qs_template_summary <name>: a short one-line description for the picker.
# Read from the template's first prose line would be fragile; use a small
# curated table so the picker copy is stable and honest.
_qs_template_summary() {
    case "$1" in
        simple-todo-app)     printf 'A minimal todo list app';;
        saas-starter)        printf 'Multi-tenant SaaS with auth';;
        rest-api-auth)       printf 'REST API with authentication';;
        rest-api)            printf 'REST API service';;
        api-only)            printf 'Backend API, no frontend';;
        ai-chatbot)          printf 'AI chatbot with an LLM backend';;
        blog-platform)       printf 'Blog / CMS platform';;
        chrome-extension)    printf 'Chrome browser extension';;
        cli-tool)            printf 'Command-line tool';;
        dashboard)           printf 'Analytics / admin dashboard';;
        data-pipeline)       printf 'Data pipeline / ETL';;
        discord-bot)         printf 'Discord bot';;
        e-commerce)          printf 'E-commerce storefront';;
        full-stack-demo)     printf 'Full-stack demo app';;
        game)                printf 'Browser game';;
        microservice)        printf 'Standalone microservice';;
        mobile-app)          printf 'Mobile app';;
        npm-library)         printf 'Publishable npm library';;
        slack-bot)           printf 'Slack bot';;
        static-landing-page) printf 'Static marketing landing page';;
        web-scraper)         printf 'Web scraper';;
        *)                   printf 'PRD template';;
    esac
}

# _qs_shipped_template_names: print every shipped template basename in stable
# catalog order. The filesystem is the source of truth: adding or removing a
# templates/*.md payload changes discovery automatically, while README.md is
# deliberately excluded because it is gallery documentation, not a PRD.
_qs_shipped_template_names() {
    local tdir; tdir="$(_qs_templates_dir)"
    local f name
    for f in "$tdir"/*.md; do
        [ -f "$f" ] || continue
        name=$(basename "$f" .md)
        [ "$name" = "README" ] && continue
        printf '%s\n' "$name"
    done | LC_ALL=C sort
}

# _qs_list_templates [json]: provider-free discovery for terminals and local
# automation. Human and machine output are derived from the same shipped-name
# stream and the same stable purpose table used by the interactive picker.
_qs_list_templates() {
    local json_output="${1:-false}"
    local catalog="" count=0 name purpose
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        purpose="$(_qs_template_summary "$name")"
        catalog="${catalog}${name}\t${purpose}\n"
        count=$((count + 1))
    done < <(_qs_shipped_template_names)

    if [ "$count" -eq 0 ]; then
        printf 'No shipped quickstart templates were found.\n' >&2
        return 2
    fi

    if [ "$json_output" = true ]; then
        printf '%b' "$catalog" | python3 -c '
import json
import sys

templates = []
for raw in sys.stdin:
    name, purpose = raw.rstrip("\n").split("\t", 1)
    templates.append({"name": name, "purpose": purpose})
json.dump(
    {
        "schema_version": 1,
        "command": "loki quickstart",
        "mode": "list-templates",
        "templates": templates,
    },
    sys.stdout,
    separators=(",", ":"),
    sort_keys=True,
)
sys.stdout.write("\n")
' || return 2
        return 0
    fi

    printf '%sShipped quickstart templates (%d)%s\n' "$_QS_BOLD" "$count" "$_QS_NC"
    printf '%b' "$catalog" | while IFS=$'\t' read -r name purpose; do
        [ -n "$name" ] || continue
        printf '  %-20s %s\n' "$name" "$purpose"
    done
    return 0
}

# _qs_template_exists <name>: accept only an exact shipped template basename.
# Keeping validation here (rather than accepting an arbitrary path) prevents
# --template from becoming a second PRD/file-read surface. The intentionally
# narrow character set also makes names safe to join below without traversal.
_qs_template_exists() {
    local name="${1:-}"
    case "$name" in
        ""|*[!a-z0-9-]*) return 1;;
    esac
    [ "$name" != "README" ] || return 1
    [ -f "$(_qs_templates_dir)/$name.md" ]
}

# _qs_selected_provider: print the provider a build would ACTUALLY pick, or
# nothing. Single source of truth is providers/loader.sh auto_detect_provider --
# the same seam render_provider_availability (provider-offer.sh:395) uses, and
# for the same institutionalized reason it states: "the selected provider is
# always whatever auto_detect_provider returns, never re-derived here."
#
# Step 1 used to re-derive that list inline as `for _p in claude codex cline
# aider`, which was wrong in two independent ways once v8.64.0 made provider
# selection automatic:
#   1. opencode was MISSING. On an opencode-only machine the loop set found=""
#      and, worse, detect_any_provider (provider-offer.sh:67, the same stale
#      four) returned 1, so quickstart took the install-offer branch and told a
#      perfectly working machine "No provider available; cannot start a build",
#      pushing a redundant `npm install -g @anthropic-ai/claude-code`.
#   2. codex and cline were SWAPPED relative to auto_detect_provider's
#      claude cline codex aider opencode, so a machine with both was told
#      "Found: codex" while the runner would really pick cline.
#
# Subshelled and path-derived from THIS FILE (never SKILL_DIR, which is unset
# when tests source this standalone), so a missing or broken loader degrades
# silently to empty rather than erroring -- the render_provider_availability
# contract. Safe as a gate because every providers/*.sh provider_detect is a
# plain `command -v` binary check, so this cannot fail open onto a runner with
# nothing to invoke.
_qs_selected_provider() {
    local _here
    _here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || return 1
    local _loader="$_here/providers/loader.sh"
    [ -f "$_loader" ] || return 1
    (
        # shellcheck source=/dev/null
        source "$_loader" >/dev/null 2>&1 || exit 1
        declare -f auto_detect_provider >/dev/null 2>&1 || exit 1
        auto_detect_provider 2>/dev/null
    )
}

# _qs_emit_plan <prd_path>: render the step-4 plan block from the REAL estimator.
# Honesty invariant: NO LOKI_COMPLEXITY override is passed, so the complexity,
# iterations, and cost are exactly what cmd_start will run with (cmd_start
# auto-detects complexity from the same PRD). Returns 0 if a number was shown,
# non-zero if the estimator gave no result (caller falls back to a no-number
# confirm, never fabricating a figure).
_qs_emit_plan() {
    local prd_path="$1" template_name="$2" json_output="${3:-false}" input_kind="${4:-idea}" input_value="${5:-}"
    local source_digest_before="" source_digest_after=""
    if [ "$json_output" = true ] && [ "$input_kind" = "prd" ]; then
        source_digest_before=$(shasum -a 256 "$prd_path" 2>/dev/null | awk '{print $1}') || return 1
        [ -n "$source_digest_before" ] || return 1
    fi
    local plan_json=""
    plan_json=$(show_prd_plan "$prd_path" "true" "false" 2>/dev/null) || plan_json=""
    if [ -z "$plan_json" ]; then
        return 1
    fi
    if [ "$json_output" = true ] && [ "$input_kind" = "prd" ]; then
        source_digest_after=$(shasum -a 256 "$prd_path" 2>/dev/null | awk '{print $1}') || return 1
        [ "$source_digest_before" = "$source_digest_after" ] || return 1
    fi
    local parsed
    parsed=$(printf '%s' "$plan_json" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
cost = d.get('cost', {}).get('total_usd')
time_est = d.get('time', {}).get('estimated')
iters = d.get('iterations', {}).get('estimated')
rng = d.get('iterations', {}).get('range', [])
tier = d.get('complexity', {}).get('tier', '')
if cost is None or time_est is None or iters is None:
    sys.exit(1)
rng_str = ''
if isinstance(rng, list) and len(rng) == 2:
    rng_str = ' (range {}-{})'.format(rng[0], rng[1])
print(tier.upper())
print('{:.2f}'.format(float(cost)))
print(time_est)
print('{}{}'.format(iters, rng_str))
" 2>/dev/null) || parsed=""
    if [ -z "$parsed" ]; then
        return 1
    fi

    if [ "$json_output" = true ]; then
        local json_payload=""
        json_payload=$(printf '%s' "$plan_json" | python3 -c '
import json
import sys

plan = json.load(sys.stdin)
if not isinstance(plan, dict):
    sys.exit(1)
template_name, input_kind, input_value, source_digest = sys.argv[1:5]
if input_kind == "idea":
    continuation = {
        "kind": "idea",
        "template": template_name,
        "value": input_value,
    }
else:
    continuation = {
        "kind": "prd",
        "path": input_value,
        "sha256": source_digest,
    }
payload = {
    "schema_version": 1,
    "command": "loki quickstart",
    "mode": "dry-run",
    "input_kind": input_kind,
    "selected_template": template_name if input_kind == "idea" else None,
    "source_name": template_name if input_kind == "prd" else None,
    "plan": plan,
    "continuation": continuation,
}
json.dump(payload, sys.stdout, separators=(",", ":"), sort_keys=True)
' "$template_name" "$input_kind" "$input_value" "$source_digest_after" 2>/dev/null) || json_payload=""
        [ -n "$json_payload" ] || return 1
        printf '%s\n' "$json_payload" >&3
        return 0
    fi
    local tier_u cost_u time_u iter_u
    tier_u=$(printf '%s' "$parsed" | sed -n '1p')
    cost_u=$(printf '%s' "$parsed" | sed -n '2p')
    time_u=$(printf '%s' "$parsed" | sed -n '3p')
    iter_u=$(printf '%s' "$parsed" | sed -n '4p')

    printf '  Template:    %s\n' "$template_name"
    printf '  Complexity:  %s\n' "$tier_u"
    printf '  Cost:        ~$%s\n' "$cost_u"
    printf '  Time:        ~%s\n' "$time_u"
    printf '  Iterations:  %s\n' "$iter_u"
    printf '\n'
    printf '  This is an estimate. Actual usage depends on PRD complexity, the AI\n'
    printf '  provider, and how many iterations the build needs.\n'
    printf '\n'
    return 0
}

# _qs_load_preview <path>: validate one bounded schema-v1 preview before any
# provider, estimator, PRD, or build boundary. Only the continuation fields are
# handed to the shell. The saved plan is evidence, not execution authority;
# cmd_quickstart always recomputes and displays the current estimator result.
_qs_load_preview() {
    local preview_path="$1"
    if [ "$preview_path" = "-" ]; then
        if [ -t 0 ]; then
            printf 'Preview stdin must be piped; refusing to wait on a terminal.\n' >&2
            return 2
        fi
    else
        if [ ! -f "$preview_path" ] || [ ! -r "$preview_path" ] || [ -L "$preview_path" ]; then
            printf 'Preview path is not a readable regular non-symlink file: %s\n' "$preview_path" >&2
            return 2
        fi
        local preview_size
        preview_size=$(wc -c < "$preview_path" 2>/dev/null | tr -d '[:space:]') || return 2
        case "$preview_size" in
            ""|*[!0-9]*) return 2;;
        esac
        if [ "$preview_size" -eq 0 ] || [ "$preview_size" -gt 1048576 ]; then
            printf 'Preview JSON must be between 1 byte and 1 MiB.\n' >&2
            return 2
        fi
    fi

    local validator_code=""
    validator_code=$(cat <<'PY'
import base64
import json
import os
import re
import stat
import sys

path = sys.argv[1]
try:
    if path == "-":
        raw = sys.stdin.buffer.read(1048577)
        if len(raw) < 1 or len(raw) > 1048576:
            raise ValueError("unsafe preview stdin")
    else:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size < 1 or metadata.st_size > 1048576:
                raise ValueError("unsafe preview")
            raw = os.read(descriptor, 1048577)
        finally:
            os.close(descriptor)
    if len(raw) > 1048576:
        raise ValueError("oversized")
    def reject_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    payload = json.loads(raw, object_pairs_hook=reject_duplicate_keys)
except Exception:
    sys.exit(2)

if not isinstance(payload, dict):
    sys.exit(2)
if payload.get("schema_version") != 1:
    sys.exit(2)
if payload.get("command") != "loki quickstart" or payload.get("mode") != "dry-run":
    sys.exit(2)
if not isinstance(payload.get("plan"), dict) or not payload["plan"]:
    sys.exit(2)

continuation = payload.get("continuation")
if not isinstance(continuation, dict):
    sys.exit(2)
kind = continuation.get("kind")

def valid_text(value):
    return (
        isinstance(value, str)
        and 0 < len(value) <= 4096
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    )

if kind == "idea":
    value = continuation.get("value")
    template = continuation.get("template")
    if not valid_text(value):
        sys.exit(2)
    if not isinstance(template, str) or re.fullmatch(r"[a-z0-9-]+", template) is None:
        sys.exit(2)
    if payload.get("input_kind") != "idea":
        sys.exit(2)
    if payload.get("selected_template") != template or payload.get("source_name") is not None:
        sys.exit(2)
    encoded = base64.b64encode(value.encode("utf-8")).decode("ascii")
    print(f"idea|{template}|{encoded}|")
elif kind == "prd":
    value = continuation.get("path")
    digest = continuation.get("sha256")
    if not valid_text(value):
        sys.exit(2)
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        sys.exit(2)
    if payload.get("input_kind") != "prd":
        sys.exit(2)
    if payload.get("selected_template") is not None or payload.get("source_name") != os.path.basename(value):
        sys.exit(2)
    encoded = base64.b64encode(value.encode("utf-8")).decode("ascii")
    print(f"prd||{encoded}|{digest}")
else:
    sys.exit(2)
PY
)
    python3 -c "$validator_code" "$preview_path"
}

# _qs_verify_preview <path> <json>: prove that one bounded schema-v1 preview is
# still actionable without crossing provider, estimator, PRD-write, or build
# boundaries. Idea previews must name a currently shipped template. PRD
# previews must still resolve to the exact readable non-symlink file digest.
# Output deliberately excludes the idea and PRD path.
_qs_verify_preview() {
    local preview_path="$1" json_output="${2:-false}"
    local fields="" kind="" template="" encoded="" digest="" value=""
    fields=$(_qs_load_preview "$preview_path") || {
        printf 'Preview JSON is malformed or incompatible.\n' >&2
        return 2
    }
    IFS='|' read -r kind template encoded digest <<< "$fields"
    value=$(python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.argv[1], validate=True))' "$encoded" 2>/dev/null) || {
        printf 'Preview JSON continuation is invalid.\n' >&2
        return 2
    }
    [ -n "$value" ] || {
        printf 'Preview JSON continuation is empty.\n' >&2
        return 2
    }

    local verdict=""
    if [ "$kind" = "idea" ]; then
        if ! _qs_template_exists "$template"; then
            printf 'Preview template is not currently shipped: %s\n' "$template" >&2
            return 2
        fi
        verdict="SHIPPED_TEMPLATE_MATCH"
    elif [ "$kind" = "prd" ]; then
        if [ ! -f "$value" ] || [ ! -r "$value" ] || [ -L "$value" ]; then
            printf 'Preview PRD is not a readable regular non-symlink file.\n' >&2
            return 2
        fi
        local current_digest=""
        current_digest=$(shasum -a 256 "$value" 2>/dev/null | awk '{print $1}') || current_digest=""
        if [ -z "$current_digest" ] || [ "$current_digest" != "$digest" ]; then
            printf 'Preview PRD has changed since the saved preview; run --dry-run --json again.\n' >&2
            return 2
        fi
        verdict="EXACT_PRD_MATCH"
    else
        printf 'Preview JSON continuation kind is unsupported.\n' >&2
        return 2
    fi

    if [ "$json_output" = true ]; then
        python3 - "$kind" "$template" "$digest" "$verdict" <<'PY'
import json
import sys

kind, template, digest, verdict = sys.argv[1:5]
json.dump(
    {
        "command": "loki quickstart",
        "input_kind": kind,
        "mode": "verify-preview",
        "prd_sha256": digest if kind == "prd" else None,
        "schema_version": 1,
        "selected_template": template if kind == "idea" else None,
        "valid": True,
        "verdict": verdict,
    },
    sys.stdout,
    separators=(",", ":"),
    sort_keys=True,
)
sys.stdout.write("\n")
PY
        return $?
    fi

    if [ "$kind" = "idea" ]; then
        printf 'VERIFIED / %s / template=%s\n' "$verdict" "$template"
    else
        printf 'VERIFIED / %s / sha256=%s\n' "$verdict" "$digest"
    fi
    return 0
}

# _qs_help: concise usage for `loki quickstart --help`.
_qs_help() {
    printf '%sloki quickstart%s - guided first build (setup, idea, template, plan, go)\n' "$_QS_BOLD" "$_QS_NC"
    printf '\n'
    printf 'A 4-step interview that takes you from a clean install to a verified\n'
    printf 'first build. Press Enter at every step to build the sample Todo app.\n'
    printf '\n'
    printf 'Usage: loki quickstart [IDEA|PRD-PATH] [options]\n'
    printf '\n'
    printf 'Arguments:\n'
    printf '  IDEA          A one-line description (pre-fills step 2)\n'
    printf '  PRD-PATH      A path to an existing PRD file (skips steps 2-3)\n'
    printf '\n'
    printf 'Options:\n'
    printf '  --yes, -y     Auto-confirm the final build prompt (still shows the plan)\n'
    printf '  --dry-run     Preview the selected template and plan; write/start nothing\n'
    printf '  --json        Emit machine-readable output for a read-only command\n'
    printf '  --from-preview F  Continue saved JSON from file F (or - for piped stdin); requires --yes\n'
    printf '  --verify-preview F  Verify saved JSON from file F (or - for piped stdin); executes nothing\n'
    printf '  --template N  Use the exact shipped template N for an IDEA\n'
    printf '  --list-templates  List every shipped template and its purpose\n'
    printf '  --help, -h    Show this help and exit\n'
    printf '\n'
    printf 'Non-interactive use:\n'
    printf '  loki quickstart "a todo app with user accounts" --yes\n'
    printf '  Both an IDEA (or PRD path) and --yes are required with no terminal.\n'
    printf '  Missing either one exits 2 and writes nothing. The top-ranked\n'
    printf '  template is chosen automatically and the plan is still shown.\n'
    printf '  Add --template NAME to choose a shipped template instead.\n'
    printf '  Run with --list-templates (and optional --json) to discover names.\n'
    printf '\n'
    printf 'Zero-spend preview:\n'
    printf '  loki quickstart "a todo app" --dry-run\n'
    printf '  An IDEA (or readable PRD path) is required. No provider is checked,\n'
    printf '  no file is written, and no build is started. Do not combine with --yes.\n'
    printf '  Add --json for versioned JSON only; --json requires --dry-run.\n'
    printf '  Save that JSON, then continue it with --from-preview FILE --yes.\n'
    printf '  Or pipe it with --from-preview - --yes; terminal stdin is refused.\n'
    printf '  Verify it without execution using --verify-preview FILE (and optional --json).\n'
    printf '\n'
    printf 'Steps:\n'
    printf '  1. Setup      Check for an AI provider for execution (skipped in preview)\n'
    printf '  2. Build      Describe what you want, or Enter for the sample Todo app\n'
    printf '  3. Template   Pick the closest starting template (offline keyword match)\n'
    printf '  4. Plan       Review the honest cost/time estimate, then confirm\n'
    printf '\n'
    printf 'The PRD is written to ./prd.md in the current directory (or the next\n'
    printf 'free prd-quickstart*.md name if that exists), then the build starts.\n'
    return 0
}

# cmd_quickstart: the 4-step guided interview. Composes provider_offer_gate
# (slice B), show_prd_plan (slice A), the template matcher, and cmd_start.
#
# Order is load-bearing:
#   argv validation -> non-TTY/CI gate (hint + exit 2) -> provider gate or skip ->
#   step 2 (idea / PRD path) -> step 3 (template) -> step 4 (plan + confirm) ->
#   write PRD to CWD -> cmd_start --yes --no-plan (subshelled; it execs the runner).
#
# The non-TTY/CI gate admits two fully-specified shapes:
#   loki quickstart "<idea>|<prd-path>" --yes
#   loki quickstart "<idea>|<prd-path>" --dry-run
# Execution requires argv consent; preview forbids it. Both paths skip prompts
# and share template ranking plus the honest estimator. Only execution crosses
# the provider, confirm, write, and cmd_start boundaries.
cmd_quickstart() {
    local positional=""
    local assume_yes=false
    local dry_run=false
    local json_output=false
    local template_override=""
    local template_flag_seen=false
    local list_templates=false
    local list_templates_flag_seen=false
    local from_preview=""
    local from_preview_flag_seen=false
    local verify_preview=""
    local verify_preview_flag_seen=false
    local preview_prd_digest=""
    if _qs_assume_yes; then assume_yes=true; fi

    # yes_flag tracks EXPLICIT --yes/-y on THIS command's argv, and nothing else.
    # It is deliberately NOT assume_yes: _qs_assume_yes also returns true for an
    # ambient LOKI_ASSUME_YES or LOKI_AUTO_CONFIRM=true, and LOKI_AUTO_CONFIRM is
    # exactly what `loki --yes <anything>` (loki:2313) and CI-ish environments
    # export. Gating the non-interactive bypass on assume_yes would let an
    # ambient env var plus a stray positional silently start a PAID build in CI
    # with no human in the loop. The safety contract asks for explicit consent,
    # so consent must come from argv. assume_yes keeps its existing meaning for
    # the confirm prompt, so the interactive journey is byte-identical.
    local yes_flag=false

    while [ $# -gt 0 ]; do
        case "$1" in
            --help|-h)
                _qs_help
                exit 0
                ;;
            --yes|-y)
                assume_yes=true
                yes_flag=true
                shift
                ;;
            --dry-run)
                dry_run=true
                shift
                ;;
            --json)
                json_output=true
                shift
                ;;
            --template)
                if [ "$template_flag_seen" = true ]; then
                    printf '%s--template may be specified only once.%s\n' "$_QS_RED" "$_QS_NC" >&2
                    exit 2
                fi
                template_flag_seen=true
                if [ $# -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
                    printf '%s--template requires an exact shipped template name.%s\n' "$_QS_RED" "$_QS_NC" >&2
                    exit 2
                fi
                template_override="$2"
                shift 2
                ;;
            --list-templates)
                if [ "$list_templates_flag_seen" = true ]; then
                    printf '%s--list-templates may be specified only once.%s\n' "$_QS_RED" "$_QS_NC" >&2
                    exit 2
                fi
                list_templates=true
                list_templates_flag_seen=true
                shift
                ;;
            --from-preview)
                if [ "$from_preview_flag_seen" = true ]; then
                    printf '%s--from-preview may be specified only once.%s\n' "$_QS_RED" "$_QS_NC" >&2
                    exit 2
                fi
                from_preview_flag_seen=true
                if [ $# -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
                    printf '%s--from-preview requires a preview JSON path.%s\n' "$_QS_RED" "$_QS_NC" >&2
                    exit 2
                fi
                from_preview="$2"
                shift 2
                ;;
            --verify-preview)
                if [ "$verify_preview_flag_seen" = true ]; then
                    printf '%s--verify-preview may be specified only once.%s\n' "$_QS_RED" "$_QS_NC" >&2
                    exit 2
                fi
                verify_preview_flag_seen=true
                if [ $# -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
                    printf '%s--verify-preview requires a preview JSON path.%s\n' "$_QS_RED" "$_QS_NC" >&2
                    exit 2
                fi
                verify_preview="$2"
                shift 2
                ;;
            --*)
                printf '%sUnknown option: %s%s\n' "$_QS_RED" "$1" "$_QS_NC" >&2
                printf "Run 'loki quickstart --help' for usage.\n" >&2
                exit 2
                ;;
            *)
                if [ -z "$positional" ]; then
                    positional="$1"
                else
                    printf '%sUnexpected extra argument: %s%s\n' "$_QS_RED" "$1" "$_QS_NC" >&2
                    printf "Run 'loki quickstart --help' for usage.\n" >&2
                    exit 2
                fi
                shift
                ;;
        esac
    done

    # Verification is a standalone read-only shape. It accepts only optional
    # JSON formatting, validates the full current continuation boundary, and
    # returns before terminal, provider, estimator, PRD-write, and build seams.
    if [ "$verify_preview_flag_seen" = true ]; then
        if [ -n "$positional" ] || [ "$yes_flag" = true ] || [ "$dry_run" = true ] || [ "$template_flag_seen" = true ] || [ "$list_templates" = true ] || [ "$from_preview_flag_seen" = true ]; then
            printf '%s--verify-preview accepts only a preview JSON path and optional --json.%s\n' "$_QS_RED" "$_QS_NC" >&2
            exit 2
        fi
        _qs_verify_preview "$verify_preview" "$json_output"
        return $?
    fi

    # Continuation is a standalone execution shape. Explicit argv consent is
    # mandatory, and no caller-supplied input or selector may compete with the
    # reviewed preview. Validation happens before every provider, estimator,
    # PRD, and build boundary. Accepted values then rejoin the existing path.
    if [ "$from_preview_flag_seen" = true ]; then
        if [ -n "$positional" ] || [ "$yes_flag" != true ] || [ "$dry_run" = true ] || [ "$json_output" = true ] || [ "$template_flag_seen" = true ] || [ "$list_templates" = true ]; then
            printf '%s--from-preview accepts only a preview JSON path and explicit --yes.%s\n' "$_QS_RED" "$_QS_NC" >&2
            exit 2
        fi
        local preview_fields="" preview_kind="" preview_template="" preview_encoded="" preview_digest="" preview_value=""
        preview_fields=$(_qs_load_preview "$from_preview") || {
            printf 'Preview JSON is malformed or incompatible.\n' >&2
            exit 2
        }
        IFS='|' read -r preview_kind preview_template preview_encoded preview_digest <<< "$preview_fields"
        preview_value=$(python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.argv[1], validate=True))' "$preview_encoded" 2>/dev/null) || {
            printf 'Preview JSON continuation is invalid.\n' >&2
            exit 2
        }
        [ -n "$preview_value" ] || {
            printf 'Preview JSON continuation is empty.\n' >&2
            exit 2
        }
        if [ "$preview_kind" = "idea" ]; then
            positional="$preview_value"
            template_override="$preview_template"
            template_flag_seen=true
        elif [ "$preview_kind" = "prd" ]; then
            positional="$preview_value"
            if [ ! -f "$positional" ] || [ ! -r "$positional" ] || [ -L "$positional" ]; then
                printf 'Preview PRD is not a readable regular non-symlink file: %s\n' "$positional" >&2
                exit 2
            fi
            local current_digest=""
            current_digest=$(shasum -a 256 "$positional" 2>/dev/null | awk '{print $1}') || current_digest=""
            if [ -z "$current_digest" ] || [ "$current_digest" != "$preview_digest" ]; then
                printf 'Preview PRD has changed since the saved preview; run --dry-run --json again.\n' >&2
                exit 2
            fi
            preview_prd_digest="$preview_digest"
        else
            printf 'Preview JSON continuation kind is unsupported.\n' >&2
            exit 2
        fi
    fi

    # Discovery is a standalone read-only command shape. Refuse input and every
    # execution/preview selector rather than guessing intent; --json is its only
    # compatible modifier. This return precedes terminal, provider, estimator,
    # consent, PRD, and build boundaries.
    if [ "$list_templates" = true ]; then
        if [ -n "$positional" ] || [ "$yes_flag" = true ] || [ "$dry_run" = true ] || [ "$template_flag_seen" = true ]; then
            printf '%s--list-templates accepts only the optional --json flag.%s\n' "$_QS_RED" "$_QS_NC" >&2
            exit 2
        fi
        _qs_list_templates "$json_output"
        return $?
    fi

    # A preview is an explicit no-execution request. Reject simultaneous build
    # consent instead of guessing which instruction wins. This check precedes
    # provider discovery, estimation, and every write.
    if [ "$dry_run" = true ] && [ "$yes_flag" = true ]; then
        printf '%s--dry-run cannot be combined with --yes or -y.%s\n' "$_QS_RED" "$_QS_NC" >&2
        exit 2
    fi

    if [ "$json_output" = true ] && [ "$dry_run" != true ]; then
        printf '%s--json requires --dry-run.%s\n' "$_QS_RED" "$_QS_NC" >&2
        exit 2
    fi

    # Explicit template selection is deliberately an IDEA-only surface. It is
    # validated before provider discovery, estimation, and every write/build
    # boundary so a typo or conflicting PRD can never fall through to spend.
    if [ "$template_flag_seen" = true ]; then
        if [ -z "$positional" ]; then
            printf '%s--template requires an IDEA argument.%s\n' "$_QS_RED" "$_QS_NC" >&2
            exit 2
        fi
        case "$positional" in
            */*|*.md|*.markdown|*.txt|*.json|*.yaml|*.yml)
                printf '%s--template cannot be combined with a PRD path.%s\n' "$_QS_RED" "$_QS_NC" >&2
                exit 2
                ;;
        esac
        if [ -f "$positional" ]; then
            printf '%s--template cannot be combined with a PRD path.%s\n' "$_QS_RED" "$_QS_NC" >&2
            exit 2
        fi
        if ! _qs_template_exists "$template_override"; then
            printf '%sUnknown shipped template: %s%s\n' "$_QS_RED" "$template_override" "$_QS_NC" >&2
            exit 2
        fi
    fi

    # Preview is deliberately non-interactive: without an explicit idea or PRD
    # path there is nothing deterministic to estimate. A path-looking argument
    # must resolve to a readable regular file; otherwise treating a typo such as
    # ./prd.md as prose would preview an unrelated template and mislead the user.
    if [ "$dry_run" = true ]; then
        if [ -z "$positional" ]; then
            printf 'loki quickstart --dry-run requires an IDEA or readable PRD path.\n' >&2
            exit 2
        fi
        case "$positional" in
            */*|*.md|*.markdown|*.txt|*.json|*.yaml|*.yml)
                if [ ! -f "$positional" ] || [ ! -r "$positional" ]; then
                    printf 'PRD path is not a readable file: %s\n' "$positional" >&2
                    exit 2
                fi
                ;;
        esac
    fi

    # Non-TTY / CI: quickstart is interactive by definition, so by default it
    # never hangs on a read -- it prints the automation hint to stderr and exits
    # 2 (design 3.8).
    #
    # The execution exception is a fully-specified invocation:
    #   loki quickstart "<idea>" --yes      (or a PRD path in place of the idea)
    # Both halves are required. A non-empty positional supplies the input that
    # steps 2-3 would otherwise have to ask for, and an explicit argv --yes
    # supplies the consent step 4 would otherwise have to ask for. With both
    # present there is nothing left to prompt about, so the refusal is pure
    # friction for a newly installed operator running one command.
    #
    # Missing EITHER half keeps the refusal verbatim and writes nothing: a bare
    # `loki quickstart` in CI still cannot spend, and neither can one that has an
    # idea but no consent. Fail-closed is the load-bearing direction here -- the
    # bypass must be something an operator opts into by typing both, never
    # something an environment can arrive at on its own.
    local noninteractive_ok=false
    if _qs_non_interactive; then
        if [ "$dry_run" = true ] || { [ -n "$positional" ] && [ "$yes_flag" = true ]; }; then
            noninteractive_ok=true
        else
            printf 'loki quickstart is interactive and needs a terminal. For automation use: loki start <prd> --yes\n' >&2
            exit 2
        fi
    fi

    # Machine-readable preview follows the exact same selection and estimator
    # path as the human preview. Suppress presentation stdout while retaining a
    # duplicate of the caller's stdout on fd 3; _qs_emit_plan writes the single
    # validated JSON object there only after estimation succeeds. Stderr stays
    # available for fail-closed diagnostics.
    local json_stdout_redirected=false
    if [ "$json_output" = true ]; then
        exec 3>&1 1>/dev/null
        json_stdout_redirected=true
    fi

    printf '\n'
    if [ "$dry_run" = true ]; then
        printf '%sLoki Mode quickstart preview -- template and plan only.%s\n' "$_QS_BOLD" "$_QS_NC"
    else
        printf '%sLoki Mode quickstart -- four quick questions, then your build starts.%s\n' "$_QS_BOLD" "$_QS_NC"
    fi
    printf '\n'

    # ----- Step 1 of 4: Setup (reuse the slice-B provider offer) -------------
    printf '%sStep 1 of 4: Setup%s\n' "$_QS_BOLD" "$_QS_NC"
    if [ "$dry_run" = true ]; then
        # Estimation and deterministic template selection are local. Previewing
        # must work before provider installation and must not run provider code.
        printf '  Preview mode: provider check skipped; no build will start.\n'
    else
        printf '  Checking for an AI provider CLI ...\n'
    # Ask the loader FIRST: it is the only thing that knows what the runner will
    # really pick, and it is the only check that sees opencode. Falling back to
    # detect_any_provider (stale four, PATH-only) keeps the no-provider guard
    # intact when the loader is absent or unreadable.
        local found=""
        found="$(_qs_selected_provider)" || found=""
        if [ -n "$found" ]; then
            printf '  Found: %s. Good.\n' "$found"
        elif detect_any_provider; then
            printf '  Found: an AI provider CLI. Good.\n'
        else
            # Run the inline install + login offer. provider_offer_gate returns 2 if
            # no provider ends up available (declined, or install failed).
            if ! provider_offer_gate; then
                printf '%sNo provider available; cannot start a build. Install one and re-run loki quickstart.%s\n' "$_QS_RED" "$_QS_NC" >&2
                exit 2
            fi
        fi
    fi
    printf '\n'

    # ----- Step 2 of 4: What to build ---------------------------------------
    # A positional PRD path skips steps 2-3 entirely (design 3.8). A positional
    # one-liner pre-fills the idea. Otherwise prompt (Enter = sample Todo app).
    local prd_source=""        # an existing PRD file path, when the user has one
    local brief=""             # the one-line idea (drives template matching)
    local template_name=""
    local input_kind="idea"

    if [ -n "$positional" ] && [ -f "$positional" ]; then
        prd_source="$positional"
        input_kind="prd"
        printf '%sUsing your PRD: %s%s\n' "$_QS_DIM" "$positional" "$_QS_NC"
        printf '\n'
    else
        printf '%sStep 2 of 4: What do you want to build?%s\n' "$_QS_BOLD" "$_QS_NC"
        if [ "$dry_run" = true ]; then
            brief="$positional"
            printf '  Previewing idea: %s\n' "$brief"
        else
            printf '  Describe it in one line, or paste a path to a PRD file.\n'
            printf '  (Press Enter to build the sample Todo app.)\n'
            if [ -n "$positional" ]; then
                brief="$positional"
                printf '> %s\n' "$brief"
            else
                local answer=""
                printf '> '
                read -r answer 2>/dev/null || answer=""
                # If the typed value is an existing file, treat it as a PRD path.
                if [ -n "$answer" ] && [ -f "$answer" ]; then
                    prd_source="$answer"
                else
                    brief="$answer"
                fi
            fi
        fi
        printf '\n'
    fi

    # ----- Step 3 of 4: Pick a template (skipped if a PRD path was given) ----
    if [ -z "$prd_source" ]; then
        if [ -n "$template_override" ]; then
            template_name="$template_override"
            printf '%sStep 3 of 4: Template%s\n' "$_QS_BOLD" "$_QS_NC"
            printf '  Selected %s (--template).\n\n' "$template_name"
        else
        local -a top3=()
        local line
        while IFS= read -r line; do
            [ -n "$line" ] && top3+=("$line")
        done < <(_qs_score_templates "$brief")

        # Defensive: guarantee a default if scoring produced nothing.
        if [ "${#top3[@]}" -eq 0 ]; then
            top3=("simple-todo-app")
        fi

        # The MENU, not just the read, is interactive-only. Offering "Choose 1-3"
        # to a shell that can never answer is a prompt the operator has to read
        # and mistrust; worse, it makes a transcript indistinguishable from one
        # that actually stopped for input. The ranking above is shared by both
        # paths -- only its presentation differs.
        local pick=""
        if [ "$noninteractive_ok" != true ]; then
            printf '%sStep 3 of 4: Pick a starting template%s\n' "$_QS_BOLD" "$_QS_NC"
            if [ -n "$brief" ]; then
                printf '  Closest matches for "%s":\n' "$brief"
            else
                printf '  Closest matches for the sample Todo app:\n'
            fi
            local i=1 t suffix
            for t in "${top3[@]}"; do
                suffix=""
                [ "$i" -eq 1 ] && suffix="   (default)"
                printf '    %d) %-18s %s%s\n' "$i" "$t" "$(_qs_template_summary "$t")" "$suffix"
                i=$((i + 1))
            done
            printf '  Choose 1-%d, or press Enter for 1.\n' "${#top3[@]}"
            printf '> '
            read -r pick 2>/dev/null || pick=""
            printf '\n'
        else
            # Deterministic selection: the empty pick below resolves to top3[0],
            # the same rank the interactive picker offers as "(default)". The
            # ranking itself is unchanged -- _qs_score_templates is offline,
            # deterministic and already the single source of order -- so the
            # non-interactive choice is exactly the one an operator pressing
            # Enter would get. No picker, no prompt, no second code path.
            printf '%sStep 3 of 4: Template%s\n' "$_QS_BOLD" "$_QS_NC"
            printf '  Selected %s (top match) for "%s".\n\n' "${top3[0]}" "$brief"
        fi

        case "$pick" in
            ""|1) template_name="${top3[0]}";;
            2) template_name="${top3[1]:-${top3[0]}}";;
            3) template_name="${top3[2]:-${top3[0]}}";;
            *) template_name="${top3[0]}";;  # any unexpected input -> the default
        esac

        fi

        local tdir; tdir="$(_qs_templates_dir)"
        prd_source="$tdir/$template_name.md"
        if [ ! -f "$prd_source" ]; then
            printf '%sTemplate file not found: %s%s\n' "$_QS_RED" "$prd_source" "$_QS_NC" >&2
            exit 1
        fi
    else
        template_name="$(basename "$prd_source")"
    fi

    # ----- Step 4 of 4: Review the plan (reuse the slice-A estimator) --------
    printf '%sStep 4 of 4: Review the plan%s\n' "$_QS_BOLD" "$_QS_NC"
    # The plan is ALWAYS rendered, on both paths, from the same real estimator.
    # The non-interactive path shows it before execution rather than before a
    # prompt: the operator still gets the honest quote in the transcript, and it
    # is still the figure cmd_start runs with, so the quote equals the charge.
    if [ -n "$preview_prd_digest" ]; then
        local pre_estimate_digest=""
        if [ ! -f "$prd_source" ] || [ ! -r "$prd_source" ] || [ -L "$prd_source" ]; then
            printf 'Preview PRD changed before estimation; run --dry-run --json again.\n' >&2
            return 2
        fi
        pre_estimate_digest=$(shasum -a 256 "$prd_source" 2>/dev/null | awk '{print $1}') || pre_estimate_digest=""
        if [ "$pre_estimate_digest" != "$preview_prd_digest" ]; then
            printf 'Preview PRD changed before estimation; run --dry-run --json again.\n' >&2
            return 2
        fi
    fi
    local estimate_ok=true
    if ! _qs_emit_plan "$prd_source" "$template_name" "$json_output" "$input_kind" "$positional"; then
        estimate_ok=false
        # No honest number available. Interactively this flips the confirm to
        # default-NO below. Non-interactively there is no one to review the
        # missing plan, so fail closed before writing a PRD or starting a build.
        # Explicit --yes authorizes the displayed estimate; it is not consent
        # to spend without one.
        if [ "$noninteractive_ok" = true ]; then
            if [ "$json_stdout_redirected" = true ]; then
                exec 1>&3 3>&-
                json_stdout_redirected=false
            fi
            printf 'Could not compute a cost estimate; non-interactive quickstart requires a displayed plan and started no build.\n' >&2
            return 2
        else
            printf '%sCould not compute a cost estimate (the estimator did not return a result).%s\n' "$_QS_YELLOW" "$_QS_NC"
            printf '\n'
        fi
    fi

    if [ -n "$preview_prd_digest" ]; then
        local post_estimate_digest=""
        if [ ! -f "$prd_source" ] || [ ! -r "$prd_source" ] || [ -L "$prd_source" ]; then
            printf 'Preview PRD changed during estimation; started no build.\n' >&2
            return 2
        fi
        post_estimate_digest=$(shasum -a 256 "$prd_source" 2>/dev/null | awk '{print $1}') || post_estimate_digest=""
        if [ "$post_estimate_digest" != "$preview_prd_digest" ]; then
            printf 'Preview PRD changed during estimation; started no build.\n' >&2
            return 2
        fi
    fi

    # The preview terminal boundary is intentionally immediately after the
    # shared estimator. Reaching it proves the same template and plan were
    # rendered, while returning here makes the confirm, PRD copy, and cmd_start
    # structurally unreachable.
    if [ "$dry_run" = true ]; then
        printf 'Preview complete. No provider was run, no file was written, and no build was started.\n'
        if [ "$json_stdout_redirected" = true ]; then
            exec 1>&3 3>&-
        fi
        return 0
    fi

    # ----- Confirm ----------------------------------------------------------
    if [ "$assume_yes" != true ]; then
        local confirm=""
        if [ "$estimate_ok" = true ]; then
            # Default YES.
            printf 'Start the build now? [Y/n] '
            read -r confirm 2>/dev/null || confirm=""
            if [[ -n "$confirm" && ! "$confirm" =~ ^[Yy] ]]; then
                printf '\nCancelled. Nothing was spent.\n'
                exit 0
            fi
        else
            # No honest number available: default NO (the safe direction).
            printf 'Start the build anyway? [y/N] '
            read -r confirm 2>/dev/null || confirm=""
            if [[ ! "$confirm" =~ ^[Yy] ]]; then
                printf '\nCancelled. Nothing was spent.\n'
                exit 0
            fi
        fi
    fi

    # ----- Land the PRD at ./prd.md (design 3.6) ----------------------------
    local target="./prd.md"
    if [ -e "$target" ]; then
        local overwrite=""
        # Non-interactive never asks and never overwrites. Leaving $overwrite
        # empty falls into the existing suffix walk below, which is already the
        # correct no-clobber behavior -- prd-quickstart.md, then numbered free
        # suffixes exactly as needed. Reused rather than reimplemented so the two
        # paths cannot drift, and so "never overwrite" holds by construction
        # (there is no branch here that can reach the clobber).
        if [ "$noninteractive_ok" != true ]; then
            printf 'prd.md already exists. Overwrite? [y/N] '
            read -r overwrite 2>/dev/null || overwrite=""
        fi
        if [[ ! "$overwrite" =~ ^[Yy] ]]; then
            # Declining to overwrite one file must never silently destroy
            # another (bug-hunt MEDIUM): the fallback gets the same existence
            # guard, walking numbered suffixes until a free name is found.
            target="./prd-quickstart.md"
            local _qs_n=2
            while [ -e "$target" ]; do
                target="./prd-quickstart-${_qs_n}.md"
                _qs_n=$((_qs_n + 1))
                if [ "$_qs_n" -gt 100 ]; then
                    printf '%sCould not find a free PRD filename (prd-quickstart-*.md all taken).%s\n' "$_QS_RED" "$_QS_NC" >&2
                    exit 1
                fi
            done
        fi
    fi
    if [ "$from_preview_flag_seen" = true ]; then
        # A reviewed continuation must publish exactly the bytes that were
        # previewed, and must never win a race by overwriting another file.
        # Stage in the destination directory, verify the staged bytes, then
        # claim the final name with an atomic hard link (which fails if another
        # process created it after the suffix walk). Removing the private stage
        # leaves the linked final file intact.
        local preview_stage="" preview_stage_digest=""
        preview_stage=$(mktemp "./.loki-quickstart-prd.XXXXXX") || {
            printf '%sCould not stage the reviewed PRD in the current directory.%s\n' "$_QS_RED" "$_QS_NC" >&2
            return 2
        }
        if ! cp "$prd_source" "$preview_stage" 2>/dev/null; then
            rm -f "$preview_stage"
            printf '%sCould not stage the reviewed PRD in the current directory.%s\n' "$_QS_RED" "$_QS_NC" >&2
            return 2
        fi
        preview_stage_digest=$(shasum -a 256 "$preview_stage" 2>/dev/null | awk '{print $1}') || preview_stage_digest=""
        if [ -z "$preview_stage_digest" ] || { [ -n "$preview_prd_digest" ] && [ "$preview_stage_digest" != "$preview_prd_digest" ]; }; then
            rm -f "$preview_stage"
            printf '%sReviewed PRD changed before publish; started no build.%s\n' "$_QS_RED" "$_QS_NC" >&2
            return 2
        fi
        if ! ln "$preview_stage" "$target" 2>/dev/null; then
            rm -f "$preview_stage"
            printf '%sPRD destination changed before publish; started no build.%s\n' "$_QS_RED" "$_QS_NC" >&2
            return 2
        fi
        rm -f "$preview_stage"
    elif ! cp "$prd_source" "$target" 2>/dev/null; then
        printf '%sCould not write the PRD to the current directory. Try a writable directory.%s\n' "$_QS_RED" "$_QS_NC" >&2
        exit 1
    fi

    printf '\n'
    printf 'Starting your build. Progress streams here in the terminal.\n'
    printf '  PRD saved to: %s\n' "$target"
    printf "  Tip: run 'loki dashboard' in another terminal to watch in a browser.\n"
    printf '\n'

    # ----- Compose with cmd_start -------------------------------------------
    # Consent was collected in step 4, so --yes is correct. The plan was already
    # shown in step 4, so --no-plan avoids double-printing it. No --simple: the
    # estimate shown was the auto-detect estimate, and the runner's own
    # complexity detection agrees with the estimator for the default PRD
    # (verified: detect_complexity and show_prd_plan both classify the sample
    # Todo app SIMPLE), so the quote matches the charge.
    #
    # cmd_start EXECS the runner (loki:1856, _loki_new_session_exec), so it never
    # returns into this function. We wrap it in a subshell -- the exact pattern
    # cmd_demo uses (loki:9337) -- so the exec replaces the SUBSHELL while the
    # interactive controlling tty (and Ctrl+C) is preserved, the build runs in
    # the foreground, and on failure this function's honest message stays
    # reachable. We do NOT auto-open a dashboard: the default `loki start` does
    # not start one (it is gated on --api, loki:1825), and starting one here
    # would bind port 57374, which quickstart deliberately must not own.
    local start_exit=0
    ( cmd_start "$target" --yes --no-plan ) || start_exit=$?

    if [ "$start_exit" -ne 0 ]; then
        printf "%sThe build did not start cleanly. Run 'loki doctor' and try 'loki start ./prd.md'.%s\n" "$_QS_RED" "$_QS_NC" >&2
        exit "$start_exit"
    fi

    return 0
}
