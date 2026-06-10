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

    declare -A scores
    local name f
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        name=$(basename "$f" .md)
        [ "$name" = "README" ] && continue
        scores["$name"]=0
    done < <(ls "$tdir"/*.md 2>/dev/null)

    # No templates resolvable: fall back to the guaranteed default only.
    if [ "${#scores[@]}" -eq 0 ]; then
        printf 'simple-todo-app\n'
        return 0
    fi

    local -a tokens
    read -ra tokens <<< "$(printf '%s' "$brief_lc" | tr -cs 'a-z0-9' ' ')"

    local tok kw tmpl wt
    for tok in "${tokens[@]}"; do
        [ -z "$tok" ] && continue
        _qs_is_stopword "$tok" && continue
        for name in "${!scores[@]}"; do
            case "-$name-" in
                *"-$tok-"*) scores["$name"]=$(( ${scores["$name"]} + 2 ));;
            esac
        done
        while IFS=: read -r kw tmpl wt; do
            [ -z "$kw" ] && continue
            [ -z "$wt" ] && wt=3
            if [ "$tok" = "$kw" ] && [ -n "${scores[$tmpl]+x}" ]; then
                scores["$tmpl"]=$(( ${scores["$tmpl"]} + wt ))
            fi
        done < <(_qs_keyword_map)
    done

    # Guaranteed default baseline.
    if [ -n "${scores[simple-todo-app]+x}" ]; then
        scores["simple-todo-app"]=$(( ${scores["simple-todo-app"]} + 1 ))
    fi

    # Emit "score<TAB>priority<TAB>name"; sort by score desc, priority asc
    # (simple-todo-app=0 wins ties), then name asc for full determinism.
    local prio
    for name in "${!scores[@]}"; do
        prio=1
        [ "$name" = "simple-todo-app" ] && prio=0
        printf '%s\t%s\t%s\n' "${scores[$name]}" "$prio" "$name"
    done | sort -t$'\t' -k1,1nr -k2,2n -k3,3 | head -3 | cut -f3
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

# _qs_emit_plan <prd_path>: render the step-4 plan block from the REAL estimator.
# Honesty invariant: NO LOKI_COMPLEXITY override is passed, so the complexity,
# iterations, and cost are exactly what cmd_start will run with (cmd_start
# auto-detects complexity from the same PRD). Returns 0 if a number was shown,
# non-zero if the estimator gave no result (caller falls back to a no-number
# confirm, never fabricating a figure).
_qs_emit_plan() {
    local prd_path="$1" template_name="$2"
    local plan_json=""
    plan_json=$(show_prd_plan "$prd_path" "true" "false" 2>/dev/null) || plan_json=""
    if [ -z "$plan_json" ]; then
        return 1
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
    printf '  --help, -h    Show this help and exit\n'
    printf '\n'
    printf 'Steps:\n'
    printf '  1. Setup      Check for an AI provider; offer to install if missing\n'
    printf '  2. Build      Describe what you want, or Enter for the sample Todo app\n'
    printf '  3. Template   Pick the closest starting template (offline keyword match)\n'
    printf '  4. Plan       Review the honest cost/time estimate, then confirm\n'
    printf '\n'
    printf 'The PRD is written to ./prd.md in the current directory, then the build\n'
    printf 'starts. For non-interactive automation use: loki start <prd> --yes\n'
    return 0
}

# cmd_quickstart: the 4-step guided interview. Composes provider_offer_gate
# (slice B), show_prd_plan (slice A), the template matcher, and cmd_start.
#
# Order is load-bearing:
#   --help (exit 0) -> non-TTY/CI gate (hint + exit 2) -> provider gate ->
#   step 2 (idea / PRD path) -> step 3 (template) -> step 4 (plan + confirm) ->
#   write PRD to CWD -> cmd_start --yes --no-plan (subshelled; it execs the runner).
cmd_quickstart() {
    local positional=""
    local assume_yes=false
    if _qs_assume_yes; then assume_yes=true; fi

    while [ $# -gt 0 ]; do
        case "$1" in
            --help|-h)
                _qs_help
                exit 0
                ;;
            --yes|-y)
                assume_yes=true
                shift
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

    # Non-TTY / CI: quickstart is interactive by definition. Never hang on read;
    # print the automation hint to stderr and exit 2 (design 3.8).
    if _qs_non_interactive; then
        printf 'loki quickstart is interactive and needs a terminal. For automation use: loki start <prd> --yes\n' >&2
        exit 2
    fi

    printf '\n'
    printf '%sLoki Mode quickstart -- a guided first build in about a minute.%s\n' "$_QS_BOLD" "$_QS_NC"
    printf '\n'

    # ----- Step 1 of 4: Setup (reuse the slice-B provider offer) -------------
    printf '%sStep 1 of 4: Setup%s\n' "$_QS_BOLD" "$_QS_NC"
    printf '  Checking for an AI provider CLI ...\n'
    if detect_any_provider; then
        local found=""
        local _p
        for _p in claude codex cline aider; do
            if command -v "$_p" >/dev/null 2>&1; then found="$_p"; break; fi
        done
        printf '  Found: %s. Good.\n' "$found"
    else
        # Run the inline install + login offer. provider_offer_gate returns 2 if
        # no provider ends up available (declined, or install failed).
        if ! provider_offer_gate; then
            printf '%sNo provider available; cannot start a build. Install one and re-run loki quickstart.%s\n' "$_QS_RED" "$_QS_NC" >&2
            exit 2
        fi
    fi
    printf '\n'

    # ----- Step 2 of 4: What to build ---------------------------------------
    # A positional PRD path skips steps 2-3 entirely (design 3.8). A positional
    # one-liner pre-fills the idea. Otherwise prompt (Enter = sample Todo app).
    local prd_source=""        # an existing PRD file path, when the user has one
    local brief=""             # the one-line idea (drives template matching)
    local template_name=""

    if [ -n "$positional" ] && [ -f "$positional" ]; then
        prd_source="$positional"
        printf '%sUsing your PRD: %s%s\n' "$_QS_DIM" "$positional" "$_QS_NC"
        printf '\n'
    else
        printf '%sStep 2 of 4: What do you want to build?%s\n' "$_QS_BOLD" "$_QS_NC"
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
        printf '\n'
    fi

    # ----- Step 3 of 4: Pick a template (skipped if a PRD path was given) ----
    if [ -z "$prd_source" ]; then
        local -a top3=()
        local line
        while IFS= read -r line; do
            [ -n "$line" ] && top3+=("$line")
        done < <(_qs_score_templates "$brief")

        # Defensive: guarantee a default if scoring produced nothing.
        if [ "${#top3[@]}" -eq 0 ]; then
            top3=("simple-todo-app")
        fi

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

        local pick=""
        printf '> '
        read -r pick 2>/dev/null || pick=""
        printf '\n'

        case "$pick" in
            ""|1) template_name="${top3[0]}";;
            2) template_name="${top3[1]:-${top3[0]}}";;
            3) template_name="${top3[2]:-${top3[0]}}";;
            *) template_name="${top3[0]}";;  # any unexpected input -> the default
        esac

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
    local estimate_ok=true
    if ! _qs_emit_plan "$prd_source" "$template_name"; then
        estimate_ok=false
        printf '%sCould not compute a cost estimate (the estimator did not return a result).%s\n' "$_QS_YELLOW" "$_QS_NC"
        printf '\n'
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
        printf 'prd.md already exists. Overwrite? [y/N] '
        read -r overwrite 2>/dev/null || overwrite=""
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
    if ! cp "$prd_source" "$target" 2>/dev/null; then
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
