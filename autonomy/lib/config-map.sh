#!/usr/bin/env bash
# config-map.sh -- single-source config mapping + config-file loader (FEAT-CONFIG, #691)
#
# This library is the ONE home of the YAML/config-file key mapping and the
# parse-and-export logic. It is sourced by BOTH:
#   - autonomy/loki main() pre-pass  (loki_maybe_apply_config_file, override=1)
#   - autonomy/run.sh YAML parsers   (loki_config_export_key, override=0)
# collapsing the formerly-3 tables (parse_simple_yaml, parse_yaml_with_yq,
# config.example.yaml) to ONE canonical array.
#
# DESIGN CONSTRAINT: SIDE-EFFECT-FREE ON SOURCE. Sourcing this file only DEFINES
# the array + functions. It exports nothing and runs nothing. Callers invoke the
# functions explicitly. This lets unit tests source the lib and exercise the
# parser / expander / matcher in isolation.
#
# Precedence (the keystone): an `override` parameter on the shared per-key export
# decides config-vs-env. override=1 (pre-pass) -> config BEATS ambient env;
# override=0 (run.sh auto-discovery) -> ambient env wins (shipped contract).

# Double-source guard. Re-sourcing must not redefine or re-cost anything.
if [ -n "${_LOKI_CONFIG_MAP_SOURCED:-}" ]; then
    return 0 2>/dev/null || true
fi
_LOKI_CONFIG_MAP_SOURCED=1

#===============================================================================
# 2a. Canonical mapping array (64 keys)
#
# Copied verbatim from parse_simple_yaml's set_from_yaml calls (run.sh:271-354)
# so env-var names are guaranteed correct. model.compaction_interval is EXCLUDED
# (no runtime consumer). This is the YAML/config-file surface ONLY; the
# settings.json schema (_load_json_settings) stays separate by design.
#===============================================================================
LOKI_CONFIG_MAP=(
    # core
    "core.max_retries:LOKI_MAX_RETRIES"
    "core.base_wait:LOKI_BASE_WAIT"
    "core.max_wait:LOKI_MAX_WAIT"
    "core.skip_prereqs:LOKI_SKIP_PREREQS"
    # dashboard
    "dashboard.enabled:LOKI_DASHBOARD"
    "dashboard.port:LOKI_DASHBOARD_PORT"
    # resources
    "resources.check_interval:LOKI_RESOURCE_CHECK_INTERVAL"
    "resources.cpu_threshold:LOKI_RESOURCE_CPU_THRESHOLD"
    "resources.mem_threshold:LOKI_RESOURCE_MEM_THRESHOLD"
    # security
    "security.staged_autonomy:LOKI_STAGED_AUTONOMY"
    "security.audit_log:LOKI_AUDIT_LOG"
    "security.max_parallel_agents:LOKI_MAX_PARALLEL_AGENTS"
    "security.sandbox_mode:LOKI_SANDBOX_MODE"
    "security.allowed_paths:LOKI_ALLOWED_PATHS"
    "security.blocked_commands:LOKI_BLOCKED_COMMANDS"
    # phases
    "phases.unit_tests:LOKI_PHASE_UNIT_TESTS"
    "phases.api_tests:LOKI_PHASE_API_TESTS"
    "phases.e2e_tests:LOKI_PHASE_E2E_TESTS"
    "phases.security:LOKI_PHASE_SECURITY"
    "phases.integration:LOKI_PHASE_INTEGRATION"
    "phases.code_review:LOKI_PHASE_CODE_REVIEW"
    "phases.web_research:LOKI_PHASE_WEB_RESEARCH"
    "phases.performance:LOKI_PHASE_PERFORMANCE"
    "phases.accessibility:LOKI_PHASE_ACCESSIBILITY"
    "phases.regression:LOKI_PHASE_REGRESSION"
    "phases.uat:LOKI_PHASE_UAT"
    # completion
    "completion.promise:LOKI_COMPLETION_PROMISE"
    "completion.max_iterations:LOKI_MAX_ITERATIONS"
    "completion.perpetual_mode:LOKI_PERPETUAL_MODE"
    # completion.council
    "completion.council.enabled:LOKI_COUNCIL_ENABLED"
    "completion.council.size:LOKI_COUNCIL_SIZE"
    "completion.council.threshold:LOKI_COUNCIL_THRESHOLD"
    "completion.council.check_interval:LOKI_COUNCIL_CHECK_INTERVAL"
    "completion.council.min_iterations:LOKI_COUNCIL_MIN_ITERATIONS"
    "completion.council.stagnation_limit:LOKI_COUNCIL_STAGNATION_LIMIT"
    # completion.uncertainty
    "completion.uncertainty.escalation:LOKI_UNCERTAINTY_ESCALATION"
    "completion.uncertainty.rounds:LOKI_UNCERTAINTY_ROUNDS"
    "completion.uncertainty.nochange_min:LOKI_UNCERTAINTY_NOCHANGE_MIN"
    "completion.uncertainty.split_rounds:LOKI_UNCERTAINTY_SPLIT_ROUNDS"
    # model (model.planning/development/fast are T1-only; verified env vars)
    "model.prompt_repetition:LOKI_PROMPT_REPETITION"
    "model.confidence_routing:LOKI_CONFIDENCE_ROUTING"
    "model.autonomy_mode:LOKI_AUTONOMY_MODE"
    "model.planning:LOKI_MODEL_PLANNING"
    "model.development:LOKI_MODEL_DEVELOPMENT"
    "model.fast:LOKI_MODEL_FAST"
    # parallel
    "parallel.enabled:LOKI_PARALLEL_MODE"
    "parallel.max_worktrees:LOKI_MAX_WORKTREES"
    "parallel.max_sessions:LOKI_MAX_PARALLEL_SESSIONS"
    "parallel.testing:LOKI_PARALLEL_TESTING"
    "parallel.docs:LOKI_PARALLEL_DOCS"
    "parallel.blog:LOKI_PARALLEL_BLOG"
    "parallel.auto_merge:LOKI_AUTO_MERGE"
    # complexity
    "complexity.tier:LOKI_COMPLEXITY"
    # github
    "github.import:LOKI_GITHUB_IMPORT"
    "github.pr:LOKI_GITHUB_PR"
    "github.sync:LOKI_GITHUB_SYNC"
    "github.repo:LOKI_GITHUB_REPO"
    "github.labels:LOKI_GITHUB_LABELS"
    "github.milestone:LOKI_GITHUB_MILESTONE"
    "github.assignee:LOKI_GITHUB_ASSIGNEE"
    "github.limit:LOKI_GITHUB_LIMIT"
    "github.pr_label:LOKI_GITHUB_PR_LABEL"
    # notifications
    "notifications.enabled:LOKI_NOTIFICATIONS"
    "notifications.sound:LOKI_NOTIFICATION_SOUND"
)

# Annotations for `config example|schema` generation. Maps a nested.path to a
# one-line human comment. Only used by the generators; absence is harmless.
LOKI_CONFIG_COMMENTS=(
    "core.max_retries:Max retry attempts for rate limits and transient failures"
    "core.base_wait:Base wait time in seconds for exponential backoff"
    "core.max_wait:Maximum wait time in seconds"
    "core.skip_prereqs:Skip prerequisite checks (not recommended)"
    "dashboard.enabled:Enable web dashboard"
    "dashboard.port:Dashboard port"
    "resources.check_interval:Check resources every N seconds"
    "resources.cpu_threshold:CPU percentage threshold to warn"
    "resources.mem_threshold:Memory percentage threshold to warn"
    "security.staged_autonomy:Require approval before execution (staged autonomy)"
    "security.audit_log:Enable audit logging"
    "security.max_parallel_agents:Limit concurrent agent spawning"
    "security.sandbox_mode:Run in sandboxed container (requires Docker)"
    "security.allowed_paths:Comma-separated paths agents can modify (empty = all)"
    "security.blocked_commands:Comma-separated blocked shell commands"
    "phases.unit_tests:Enable unit test phase"
    "phases.api_tests:Enable API test phase"
    "phases.e2e_tests:Enable end-to-end test phase"
    "phases.security:Enable security phase"
    "phases.integration:Enable integration phase"
    "phases.code_review:Enable code review phase"
    "phases.web_research:Enable web research phase"
    "phases.performance:Enable performance phase"
    "phases.accessibility:Enable accessibility phase"
    "phases.regression:Enable regression phase"
    "phases.uat:Enable UAT phase"
    "completion.promise:Explicit stop condition text (empty = runs until stopped)"
    "completion.max_iterations:Max loop iterations before exit"
    "completion.perpetual_mode:Ignore ALL completion signals (runs forever)"
    "completion.council.enabled:Enable completion council voting"
    "completion.council.size:Number of council reviewers"
    "completion.council.threshold:Approval threshold for council stop"
    "completion.council.check_interval:Run the council every N iterations"
    "completion.council.min_iterations:Minimum iterations before council can stop"
    "completion.council.stagnation_limit:No-change rounds before circuit-breaker"
    "completion.uncertainty.escalation:Uncertainty-gated escalation toggle (0/1)"
    "completion.uncertainty.rounds:Consecutive rounds before escalating"
    "completion.uncertainty.nochange_min:No-change proxy threshold"
    "completion.uncertainty.split_rounds:Council-split proxy threshold"
    "model.prompt_repetition:Enable prompt repetition for Haiku agents"
    "model.confidence_routing:Enable confidence-based routing"
    "model.autonomy_mode:Autonomy level: perpetual, checkpoint, or supervised"
    "model.planning:Model for the planning tier"
    "model.development:Model for the development tier"
    "model.fast:Model for the fast tier"
    "parallel.enabled:Enable git worktree-based parallelism"
    "parallel.max_worktrees:Maximum parallel worktrees"
    "parallel.max_sessions:Maximum concurrent sessions"
    "parallel.testing:Run testing stream in parallel"
    "parallel.docs:Run documentation stream in parallel"
    "parallel.blog:Run blog stream if site has blog"
    "parallel.auto_merge:Auto-merge completed features"
    "complexity.tier:Force complexity tier: auto, simple, moderate, complex, enterprise"
    "github.import:Import open issues as tasks"
    "github.pr:Create PR when feature complete"
    "github.sync:Sync status back to issues"
    "github.repo:Override repo detection (owner/repo)"
    "github.labels:Filter by labels (comma-separated)"
    "github.milestone:Filter by milestone"
    "github.assignee:Filter by assignee"
    "github.limit:Max issues to import"
    "github.pr_label:Label for PRs (empty = no label)"
    "notifications.enabled:Enable desktop notifications"
    "notifications.sound:Play sound with notifications"
)

#===============================================================================
# 2b. Known-env-var set for the .env-format key allowlist.
#
# YAML/JSON are bound to LOKI_CONFIG_MAP (only mapped nested.path keys are read),
# so a typo or unadvertised key in those formats is simply ignored. The .env
# format reads keys directly, so without a membership check ANY LOKI_* key would
# be accepted -- a typo (LOKI_MAX_RETRIE) or unadvertised key would silently pass
# `config validate` and (for the loader) be exported. To bring .env to parity, an
# .env LOKI_ key is accepted only if it is either:
#   (a) a config-map env var ("${LOKI_CONFIG_MAP[@]##*:}"), OR
#   (b) listed in LOKI_ENV_EXTRA_ALLOWLIST below.
#
# (b) holds the LOKI_* vars that are NOT in the config map but have a real
# runtime consumer and are legitimately set via .env in enterprise/durable
# deployments. Each entry below cites its consumer; do NOT add a var here without
# one.
LOKI_ENV_EXTRA_ALLOWLIST=(
    LOKI_DURABLE_STATE       # run.sh:9583 (durable-state opt-in)
    LOKI_STORAGE_BACKEND     # checkpoint_sync.py:48, lokistore/factory.py:51
    LOKI_STORAGE_BUCKET      # lokistore/factory.py:54
    LOKI_STORAGE_PREFIX      # lokistore/factory.py:57
    LOKI_STORAGE_REGION      # lokistore/factory.py:60
    LOKI_METADATA_BACKEND    # lokistore/factory.py:164
    LOKI_METADATA_URL        # lokistore/factory.py:181
    LOKI_DATA_DIR            # lokistore/factory.py:169
    LOKI_RUN_ID              # checkpoint_sync.py:56 (per-run object-store namespace)
    LOKI_SESSION_ID          # checkpoint_sync.py:56, run.sh session paths
    LOKI_DIR                 # checkpoint_sync.py:61, lokistore/factory.py:41
    LOKI_BUDGET_LIMIT        # run.sh:484 (cost cap)
    LOKI_PROVIDER            # run.sh:837 (provider select)
    LOKI_ISSUE_PROVIDER      # run.sh:455 settings mapping (issue provider)
    LOKI_MAX_TIER            # run.sh:448 settings mapping (model tier cap)
    LOKI_SLACK_WEBHOOK       # run.sh:452 settings mapping (notify)
    LOKI_DISCORD_WEBHOOK     # run.sh:453 settings mapping (notify)
    LOKI_BLIND_VALIDATION    # run.sh:456 settings mapping
    LOKI_ADVERSARIAL_TESTING # run.sh:457 settings mapping
    LOKI_SPAWN_TIMEOUT       # run.sh:458 settings mapping
    LOKI_SPAWN_RETRIES       # run.sh:459 settings mapping
)

# Return 0 if an .env LOKI_ key is a recognized var (config-map member OR an
# explicitly-allowlisted non-map var with a real consumer), else 1.
loki_env_key_is_known() {
    local key="$1"
    local mapping extra
    for mapping in "${LOKI_CONFIG_MAP[@]}"; do
        [ "${mapping##*:}" = "$key" ] && return 0
    done
    for extra in "${LOKI_ENV_EXTRA_ALLOWLIST[@]}"; do
        [ "$extra" = "$key" ] && return 0
    done
    return 1
}

#===============================================================================
# Self-contained validators (the loki process has no run.sh validate_yaml_value)
#===============================================================================

# Validate a resolved config value before export. Rejects empty, over-length,
# newlines, and shell metacharacters.
#
# NOTE: this intentionally does NOT reuse run.sh's validate_yaml_value regex
# verbatim. That shipped regex (run.sh:358, a bash `[[ =~ [\$\`...] ]]` bracket
# expression) silently matches NOTHING -- the backslash-escapes inside the
# character class are taken literally, so it never rejects a metachar. On this
# NEW security-sensitive config-file surface, the injection contract (#691 SS7
# case 8) requires real rejection, so we use a `case` glob character class,
# which bash evaluates correctly. The allow-set mirrors validate_yaml_value's
# documented intent: alphanumerics plus spaces, dots, dashes, underscores,
# slashes, colons, commas, @.
loki_validate_value() {
    local value="$1"
    local max_length="${2:-1000}"

    # Reject empty values
    if [ -z "$value" ]; then
        return 1
    fi

    # Reject values with dangerous shell metacharacters: $ ` | ; & < > ( ) { }
    # [ ] and backslash. (case glob bracket class -- evaluated reliably, unlike
    # the shipped =~ bracket regex.)
    # NOTE: single-quote and double-quote are NOT in the reject set, so a value
    # containing a quote passes. That is intentional and benign here: config
    # values are only ever quoted-exported (loki_config_export_key) or printed,
    # never eval'd, so an embedded quote cannot break out into a command. The
    # set above blocks the chars that WOULD matter for command/expansion
    # injection on the surfaces that consume these values.
    case "$value" in
        *['$`|;&<>(){}[]\']*) return 1 ;;
    esac

    # Reject values that are too long (DoS protection)
    if [ "${#value}" -gt "$max_length" ]; then
        return 1
    fi

    # Reject values with newlines (could corrupt variables)
    if [[ "$value" == *$'\n'* ]]; then
        return 1
    fi

    return 0
}

# Mirror of run.sh escape_regex (run.sh:387) for the grep/sed YAML fallback.
loki_escape_regex() {
    local input="$1"
    printf '%s' "$input" | sed 's/[.[\*?+^${}|()\\]/\\&/g'
}

# YAML scalar extractor for the no-yq fallback. Resolves a FULL nested dotted
# path (e.g. completion.council.enabled) by descending indentation, so keys
# that share a last segment (dashboard.enabled vs notifications.enabled) never
# collide. Prints the scalar value (one line) or nothing if the path is absent.
# Pure awk so it is portable across GNU and BSD (POSIX classes, no \s, no sed
# quirks). Mirrors what `yq eval ".$path // \"\""` would return for scalars.
loki_yaml_fallback_extract() {
    local file="$1" dotted_path="$2"
    [ -f "$file" ] || return 0
    awk -v path="$dotted_path" '
        BEGIN { n = split(path, want, "."); depth = 0 }
        {
            line = $0
            if (line ~ /^[[:space:]]*#/) next
            if (line ~ /^[[:space:]]*$/) next
            ind = 0
            while (substr(line, ind + 1, 1) == " ") ind++
            rest = substr(line, ind + 1)
            if (rest !~ /^[^:]+:/) next
            ci = index(rest, ":")
            key = substr(rest, 1, ci - 1)
            val = substr(rest, ci + 1)
            # Pop stack entries that are siblings or shallower than this line.
            while (depth > 0 && stack_ind[depth] >= ind) depth--
            depth++
            stack_ind[depth] = ind
            stack_key[depth] = key
            if (depth == n) {
                ok = 1
                for (i = 1; i <= n; i++) if (stack_key[i] != want[i]) { ok = 0; break }
                if (ok) {
                    sub(/^[[:space:]]+/, "", val)
                    q = substr(val, 1, 1)
                    if (q == "\"" || q == "\047") {
                        # Quoted scalar: take chars up to the matching close quote
                        # so a "#" or trailing comment inside/after stays correct.
                        rest2 = substr(val, 2)
                        qi = index(rest2, q)
                        if (qi > 0) val = substr(rest2, 1, qi - 1)
                        else val = rest2
                    } else {
                        # Unquoted: drop a trailing comment, then trailing space.
                        sub(/[[:space:]]*#.*$/, "", val)
                        sub(/[[:space:]]+$/, "", val)
                    }
                    print val
                    exit
                }
            }
        }
    ' "$file"
}

#===============================================================================
# 5a. ${VAR} env-ref expansion (NEVER eval)
#===============================================================================
# Expand full-value and embedded ${NAME} references via bash indirect expansion.
# Order is EXPAND-THEN-VALIDATE (validate rejects '$', so an unexpanded ${VAR}
# would always fail). An unset reference makes expansion FAIL (return non-zero)
# so the caller can skip the key and warn; it never exports an empty value.
#
# Echoes the expanded value on success. Returns 1 (and echoes the unresolved
# var name on stderr is the caller's job) when any referenced var is unset.
loki_expand_refs() {
    local value="$1"
    # Fast path: no ${...} at all.
    if [[ "$value" != *'${'* ]]; then
        printf '%s' "$value"
        return 0
    fi
    local out=""
    local rest="$value"
    local prefix name resolved
    while [[ "$rest" == *'${'* ]]; do
        # literal text before the next ${
        prefix="${rest%%\$\{*}"
        out+="$prefix"
        rest="${rest#"$prefix"}"        # rest now starts with ${
        rest="${rest#\$\{}"             # strip leading ${
        if [[ "$rest" != *'}'* ]]; then
            # Unterminated ${ -- treat the remainder as literal and stop.
            out+='${'
            out+="$rest"
            rest=""
            break
        fi
        name="${rest%%\}*}"             # name up to first }
        rest="${rest#*\}}"              # remainder after }
        # Only [A-Za-z_][A-Za-z0-9_]* are valid var names; anything else is literal.
        if [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
            if [ -z "${!name+x}" ]; then
                # Unset reference -> signal failure with the offending name.
                printf '%s' "$name"
                return 1
            fi
            resolved="${!name}"
            out+="$resolved"
        else
            # Not a valid name -- preserve literally.
            out+='${'
            out+="$name"
            out+='}'
        fi
    done
    out+="$rest"
    printf '%s' "$out"
    return 0
}

#===============================================================================
# 2a-0. The keystone: shared per-key export with override-mode precedence
#===============================================================================
# loki_config_export_key <env_var> <value> <override>
#   override != 1 AND env already set -> return 0 (env-wins guard; run.sh path)
#   else: ${VAR}-expand -> validate -> export
# Returns non-zero (without exporting) on unresolved ref or validation failure,
# so callers can warn. A "null"/empty post-strip value is skipped silently
# (matches run.sh's existing behavior).
loki_config_export_key() {
    local env_var="$1"
    local value="$2"
    local override="${3:-0}"

    # env-wins guard (only when NOT overriding)
    if [ "$override" != "1" ] && [ -n "${!env_var:-}" ]; then
        return 0
    fi

    # Skip empty / explicit null (parser sentinels, not an error).
    if [ -z "$value" ] || [ "$value" = "null" ]; then
        return 0
    fi

    # Expand ${VAR} refs BEFORE validation.
    local expanded
    if ! expanded="$(loki_expand_refs "$value")"; then
        # expanded holds the unresolved var name here.
        printf 'loki: config: skipping %s -- unresolved ${%s}\n' "$env_var" "$expanded" >&2
        return 1
    fi

    if ! loki_validate_value "$expanded"; then
        printf 'loki: config: rejected %s -- value failed validation (shell metachar / length / newline)\n' "$env_var" >&2
        return 1
    fi

    export "$env_var=$expanded"
    return 0
}

#===============================================================================
# 5b. Raw-secret literal detector (reuse the shipped scanner patterns)
#===============================================================================
# Returns 0 if VALUE (a single literal, NOT a ${VAR} ref) looks like a secret.
# A ${VAR}-ref value is correctly IGNORED (handled by the deny filter, same as
# run.sh _commit_scan_secret_file). Used by config-file load (warn) and
# `config validate` (error).
loki_value_looks_secret() {
    local value="${1:-}"
    [ -n "$value" ] || return 1

    # TIER 1: specific formats. No deny filter -- a format match is a finding.
    local tier1=(
        'AKIA[0-9A-Z]{16}'
        'ASIA[0-9A-Z]{16}'
        '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----'
        'gh[pousr]_[A-Za-z0-9]{36,}'
        'github_pat_[A-Za-z0-9_]{60,}'
        'xox[baprs]-[A-Za-z0-9-]{10,}'
        'sk-[A-Za-z0-9]{20,}'
        'AIza[0-9A-Za-z_-]{35}'
        'glpat-[A-Za-z0-9_-]{20,}'
    )
    local p
    for p in "${tier1[@]}"; do
        if printf '%s' "$value" | LC_ALL=C grep -Eq -e "$p" 2>/dev/null; then
            return 0
        fi
    done

    # Deny filter (same as run.sh): ${VAR} refs and placeholders are NOT secrets.
    local deny='(\$\{|\$[A-Za-z_]|process\.env|os\.(environ|getenv)|%[A-Za-z_]+%|your[-_]|redacted|changeme|change[-_]me|placeholder|example|dummy|sample|fake|<[^>]*>|x{4,}|\*{4,})'
    local tier2='(api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_/+.=-]{16,}'
    local bearer='[Bb]earer[[:space:]]+[A-Za-z0-9_.\-]{20,}'
    local uricred='[a-z][a-z0-9+.\-]*://[^/[:space:]:@]*:[^/[:space:]:@]+@'

    local surviving
    surviving="$( { printf '%s' "$value" | LC_ALL=C grep -EiI "$tier2|$bearer|$uricred" 2>/dev/null \
        | LC_ALL=C grep -Eiv "$deny" 2>/dev/null; } || true)"
    if [ -n "$surviving" ]; then return 0; fi
    return 1
}

#===============================================================================
# 4. Format detection
#===============================================================================
# Echoes "env" | "yaml" | "json" | "" (unknown). Uses extension first, then a
# content sniff on the first non-blank, non-comment line.
loki_detect_config_format() {
    local path="$1"
    local base="${path##*/}"
    case "$base" in
        *.env|.env.*) printf 'env'; return 0 ;;
        *.yaml|*.yml) printf 'yaml'; return 0 ;;
        *.json)       printf 'json'; return 0 ;;
    esac
    # Content sniff: first meaningful line.
    local line
    line="$( { grep -vE '^[[:space:]]*($|#)' "$path" 2>/dev/null | head -1; } || true)"
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    if [[ "$line" == \{* ]]; then
        printf 'json'; return 0
    elif [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]]; then
        printf 'env'; return 0
    elif [[ "$line" =~ ^[a-zA-Z0-9_.-]+: ]]; then
        printf 'yaml'; return 0
    fi
    printf ''
    return 1
}

#===============================================================================
# 4a. Flat .env parser (FULL ~250-flag coverage, day one)
#===============================================================================
# Reads KEY=VALUE lines; key allowlist ^LOKI_[A-Z0-9_]+$; each value goes through
# loki_config_export_key with the given override. Non-allowlisted keys are
# rejected with a visible warning (never a silent skip).
loki_parse_env_file() {
    local file="$1"
    local override="${2:-1}"
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip blank and comment lines.
        case "$line" in
            ''|'#'*) continue ;;
        esac
        # Strip a leading "export " prefix (common in .env files).
        line="${line#export }"
        # Must contain '='.
        case "$line" in
            *=*) ;;
            *) continue ;;
        esac
        key="${line%%=*}"
        val="${line#*=}"
        # Trim whitespace around key.
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"
        # Trim leading whitespace on value (a quoted value preserves inner spaces).
        val="${val#"${val%%[![:space:]]*}"}"
        # Strip one layer of matching surrounding quotes.
        if [[ "$val" == \"*\" && ${#val} -ge 2 ]]; then
            val="${val:1:${#val}-2}"
        elif [[ "$val" == \'*\' && ${#val} -ge 2 ]]; then
            val="${val:1:${#val}-2}"
        fi
        # Key allowlist: must look like a LOKI_ key AND be a recognized var
        # (config-map member or an allowlisted non-map var). An unknown LOKI_ key
        # is a typo or an unadvertised key; warn and skip it rather than export.
        if [[ ! "$key" =~ ^LOKI_[A-Z0-9_]+$ ]]; then
            printf 'loki: config: ignoring non-allowlisted key %s (only LOKI_* keys are accepted)\n' "$key" >&2
            continue
        fi
        if ! loki_env_key_is_known "$key"; then
            printf 'loki: config: WARNING ignoring unknown key %s (not a recognized LOKI_ config var -- typo?)\n' "$key" >&2
            continue
        fi
        # Raw-secret warning on a literal (non-ref) value.
        if [[ "$val" != *'${'* ]] && loki_value_looks_secret "$val"; then
            printf 'loki: config: WARNING %s appears to contain a raw secret literal -- use ${VAR} + env/Vault\n' "$key" >&2
        fi
        loki_config_export_key "$key" "$val" "$override" || true
    done < "$file"
}

#===============================================================================
# 4. YAML parsing (yq if present, grep/sed fallback) over LOKI_CONFIG_MAP
#===============================================================================
loki_parse_yaml_file() {
    local file="$1"
    local override="${2:-1}"
    local mapping yaml_path env_var value
    local have_yq=0
    command -v yq >/dev/null 2>&1 && have_yq=1
    for mapping in "${LOKI_CONFIG_MAP[@]}"; do
        yaml_path="${mapping%%:*}"
        env_var="${mapping##*:}"
        if [ "$have_yq" = "1" ]; then
            value="$(yq eval ".$yaml_path // \"\"" "$file" 2>/dev/null || true)"
        else
            # No-yq fallback: resolve the FULL nested dotted path by indentation
            # so same-last-segment keys (dashboard.enabled vs notifications.enabled)
            # never collide. `|| true` keeps a no-match from tripping set -e in the
            # loki CLI (which runs set -euo pipefail).
            value="$(loki_yaml_fallback_extract "$file" "$yaml_path" || true)"
        fi
        if [ "$value" = "null" ]; then value=""; fi
        if [ -z "$value" ]; then continue; fi
        # Raw-secret warning on a literal value.
        if [[ "$value" != *'${'* ]] && loki_value_looks_secret "$value"; then
            printf 'loki: config: WARNING %s appears to contain a raw secret literal -- use ${VAR} + env/Vault\n' "$env_var" >&2
        fi
        loki_config_export_key "$env_var" "$value" "$override" || true
    done
}

#===============================================================================
# 4. JSON parsing (yq native, else audited python3 pattern from _load_json_settings)
#===============================================================================
# Emits "env_var<TAB>value" lines for nested.path keys present in the file.
# Modeled on run.sh:_load_json_settings (json.load, isinstance(str) guard). The
# shell side then routes each value through loki_config_export_key, so ${VAR}
# expansion / validation / secret-warning happen uniformly with the other formats.
loki_parse_json_file() {
    local file="$1"
    local override="${2:-1}"

    if command -v yq >/dev/null 2>&1; then
        local mapping yaml_path env_var value
        for mapping in "${LOKI_CONFIG_MAP[@]}"; do
            yaml_path="${mapping%%:*}"
            env_var="${mapping##*:}"
            value="$(yq eval -p=json ".$yaml_path // \"\"" "$file" 2>/dev/null || true)"
            if [ "$value" = "null" ]; then value=""; fi
            if [ -z "$value" ]; then continue; fi
            if [[ "$value" != *'${'* ]] && loki_value_looks_secret "$value"; then
                printf 'loki: config: WARNING %s appears to contain a raw secret literal -- use ${VAR} + env/Vault\n' "$env_var" >&2
            fi
            loki_config_export_key "$env_var" "$value" "$override" || true
        done
        return 0
    fi

    # python3 fallback. The python side ONLY reads + emits tab-separated
    # env_var/value pairs (NO export, NO eval). Values are scalars coerced to
    # str; the shell does expansion/validation/export. The mapping is passed in
    # via env so it cannot drift from LOKI_CONFIG_MAP.
    if ! command -v python3 >/dev/null 2>&1; then
        printf 'loki: config: cannot parse JSON -- neither yq nor python3 found\n' >&2
        return 1
    fi
    local map_str=""
    local mapping
    for mapping in "${LOKI_CONFIG_MAP[@]}"; do
        map_str+="$mapping"$'\n'
    done
    local emitted
    emitted="$(_LOKI_CFG_JSON="$file" _LOKI_CFG_MAP="$map_str" python3 -c '
import json, os, sys

def get_nested(d, key):
    cur = d
    for p in key.split("."):
        if isinstance(cur, dict):
            cur = cur.get(p)
        else:
            return None
    return cur

try:
    with open(os.environ["_LOKI_CFG_JSON"]) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

for line in os.environ.get("_LOKI_CFG_MAP", "").splitlines():
    line = line.strip()
    if not line or ":" not in line:
        continue
    path, env_var = line.split(":", 1)
    val = get_nested(data, path)
    if val is None:
        continue
    if isinstance(val, bool):
        val = "true" if val else "false"
    elif isinstance(val, (int, float)):
        val = repr(val) if isinstance(val, float) else str(val)
    elif not isinstance(val, str):
        continue
    # Tab + newline would corrupt the record; skip such values (validation
    # would reject newlines anyway).
    if "\t" in val or "\n" in val:
        continue
    sys.stdout.write(env_var + "\t" + val + "\n")
' 2>/dev/null)" || true

    local env_var value
    while IFS=$'\t' read -r env_var value; do
        [ -n "$env_var" ] || continue
        if [[ "$value" != *'${'* ]] && loki_value_looks_secret "$value"; then
            printf 'loki: config: WARNING %s appears to contain a raw secret literal -- use ${VAR} + env/Vault\n' "$env_var" >&2
        fi
        loki_config_export_key "$env_var" "$value" "$override" || true
    done <<< "$emitted"
}

#===============================================================================
# 4 (top). loki_apply_config_file <path> [override]
#===============================================================================
# Validates the path, detects format, routes to the right parser. Default
# override=1 (the pre-pass case: config beats ambient env). Missing/unreadable
# path -> honest non-zero, NO silent fallback.
loki_apply_config_file() {
    local path="$1"
    local override="${2:-1}"

    if [ -z "$path" ]; then
        printf 'loki: config: no config path given\n' >&2
        return 1
    fi
    if [ ! -e "$path" ]; then
        printf 'loki: config: file not found: %s\n' "$path" >&2
        return 1
    fi
    # Symlink guard for project-local relative paths (mirror load_config_file).
    # Absolute paths (operator-mounted, e.g. /etc/loki/config.yaml) and paths in
    # the user's HOME are trusted; a relative project path that is a symlink is
    # rejected to prevent path-traversal via a planted link in the repo.
    case "$path" in
        /*|"$HOME"/*) : ;;
        *)
            if [ -L "$path" ]; then
                printf 'loki: config: refusing symlinked project-local config: %s\n' "$path" >&2
                return 1
            fi
            ;;
    esac
    if [ ! -r "$path" ]; then
        printf 'loki: config: file not readable: %s\n' "$path" >&2
        return 1
    fi

    local fmt
    fmt="$(loki_detect_config_format "$path")"
    case "$fmt" in
        env)  loki_parse_env_file "$path" "$override" ;;
        yaml) loki_parse_yaml_file "$path" "$override" ;;
        json) loki_parse_json_file "$path" "$override" ;;
        *)
            printf 'loki: config: cannot detect format for %s (expected .env/.yaml/.yml/.json or recognizable content)\n' "$path" >&2
            return 1
            ;;
    esac
}

#===============================================================================
# 1. loki_maybe_apply_config_file "$@"  (the loki pre-pass entry point)
#===============================================================================
# Honors LOKI_CONFIG_FILE env first, then scans "$@" for --config/--vars/
# --env-file (space and = forms) WITHOUT consuming. An explicit flag overrides
# the env var. If a path is found, applies it with override=1 (config beats env).
loki_maybe_apply_config_file() {
    local path=""
    # 1. env var first.
    if [ -n "${LOKI_CONFIG_FILE:-}" ]; then
        path="$LOKI_CONFIG_FILE"
    fi
    # 2. scan args (explicit flag overrides the env var).
    local prev=""
    local a
    for a in "$@"; do
        case "$prev" in
            --config|--vars|--env-file)
                path="$a"
                ;;
        esac
        case "$a" in
            --config=*|--vars=*|--env-file=*)
                path="${a#*=}"
                ;;
        esac
        prev="$a"
    done
    [ -n "$path" ] || return 0
    loki_apply_config_file "$path" 1
}

#===============================================================================
# 6. Generators: config example / schema (from LOKI_CONFIG_MAP, never drift)
#===============================================================================

# Look up the comment for a path (LOKI_CONFIG_COMMENTS). Echoes "" if absent.
_loki_config_comment_for() {
    local want="$1"
    local entry
    for entry in "${LOKI_CONFIG_COMMENTS[@]}"; do
        if [ "${entry%%:*}" = "$want" ]; then
            printf '%s' "${entry#*:}"
            return 0
        fi
    done
    printf ''
}

# Emit an annotated nested YAML skeleton generated from LOKI_CONFIG_MAP.
loki_config_generate_example() {
    printf '# Loki Mode Configuration File (generated by: loki config example)\n'
    printf '# Copy to .loki/config.yaml, or pass with: loki start --config <path>\n'
    printf '# Precedence: CLI flags > --config file > ambient env > auto .loki/config.yaml > defaults\n'
    printf '# Secrets: never inline. Reference an env var with ${VAR_NAME}.\n'
    printf '\n'
    local mapping path top sub leaf comment
    local cur_top="" cur_sub=""
    for mapping in "${LOKI_CONFIG_MAP[@]}"; do
        path="${mapping%%:*}"
        # Split into up to 3 segments: top.[sub.]leaf
        local IFS_save="$IFS"
        IFS='.' read -r p1 p2 p3 <<< "$path"
        IFS="$IFS_save"
        if [ -n "$p3" ]; then
            top="$p1"; sub="$p2"; leaf="$p3"
        else
            top="$p1"; sub=""; leaf="$p2"
        fi
        comment="$(_loki_config_comment_for "$path")"
        if [ "$top" != "$cur_top" ]; then
            cur_top="$top"; cur_sub=""
            printf '%s:\n' "$top"
        fi
        if [ -n "$sub" ]; then
            if [ "$sub" != "$cur_sub" ]; then
                cur_sub="$sub"
                printf '  %s:\n' "$sub"
            fi
            [ -n "$comment" ] && printf '    # %s\n' "$comment"
            printf '    %s:\n' "$leaf"
        else
            cur_sub=""
            [ -n "$comment" ] && printf '  # %s\n' "$comment"
            printf '  %s:\n' "$leaf"
        fi
    done
}

# Emit a machine-readable key -> LOKI_ENV_VAR table.
loki_config_generate_schema() {
    printf '# key\tenv_var\n'
    local mapping
    for mapping in "${LOKI_CONFIG_MAP[@]}"; do
        printf '%s\t%s\n' "${mapping%%:*}" "${mapping##*:}"
    done
}

# Validate a config file for `loki config validate <file>`. Reports unresolved
# refs, raw-secret literals (ERROR), and per-value validation failures. Returns
# non-zero on ANY failure. Reads the file directly (format-aware) WITHOUT
# exporting anything into the environment.
loki_config_validate_file() {
    local path="$1"
    local rc=0

    if [ -z "$path" ] || [ ! -e "$path" ]; then
        printf 'loki: config validate: file not found: %s\n' "$path" >&2
        return 1
    fi
    if [ ! -r "$path" ]; then
        printf 'loki: config validate: file not readable: %s\n' "$path" >&2
        return 1
    fi
    local fmt
    fmt="$(loki_detect_config_format "$path")"
    if [ -z "$fmt" ]; then
        printf 'loki: config validate: cannot detect format for %s\n' "$path" >&2
        return 1
    fi

    # Collect "env_var<TAB>value" pairs WITHOUT exporting. We reuse the parsers'
    # extraction by capturing each candidate through a subshell that only prints.
    local pairs
    pairs="$(
        _loki_cfg_collect_pairs() {
            local f="$1" fm="$2"
            case "$fm" in
                env)
                    local line key val
                    while IFS= read -r line || [ -n "$line" ]; do
                        case "$line" in ''|'#'*) continue ;; esac
                        line="${line#export }"
                        case "$line" in *=*) ;; *) continue ;; esac
                        key="${line%%=*}"; val="${line#*=}"
                        key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
                        val="${val#"${val%%[![:space:]]*}"}"
                        if [[ "$val" == \"*\" && ${#val} -ge 2 ]]; then val="${val:1:${#val}-2}";
                        elif [[ "$val" == \'*\' && ${#val} -ge 2 ]]; then val="${val:1:${#val}-2}"; fi
                        printf '%s\t%s\n' "$key" "$val"
                    done < "$f"
                    ;;
                yaml)
                    local mapping yaml_path env_var value have_yq=0
                    if command -v yq >/dev/null 2>&1; then have_yq=1; fi
                    for mapping in "${LOKI_CONFIG_MAP[@]}"; do
                        yaml_path="${mapping%%:*}"; env_var="${mapping##*:}"
                        if [ "$have_yq" = 1 ]; then
                            value="$(yq eval ".$yaml_path // \"\"" "$f" 2>/dev/null || true)"
                        else
                            # Full nested-path resolution (no same-last-segment collision).
                            value="$(loki_yaml_fallback_extract "$f" "$yaml_path" || true)"
                        fi
                        if [ "$value" = "null" ]; then value=""; fi
                        if [ -z "$value" ]; then continue; fi
                        printf '%s\t%s\n' "$env_var" "$value"
                    done
                    ;;
                json)
                    # Reuse the json parser's emit path by calling a print-only variant.
                    _loki_cfg_json_emit "$f"
                    ;;
            esac
        }
        _loki_cfg_collect_pairs "$path" "$fmt"
    )"

    local env_var value expanded
    while IFS=$'\t' read -r env_var value; do
        [ -n "$env_var" ] || continue
        # env key allowlist for .env format: must look like a LOKI_ key AND be a
        # recognized var. YAML/JSON are bound to the config map by extraction, so
        # this membership check brings .env to parity and catches typos /
        # unadvertised keys that `config validate` should reject.
        if [ "$fmt" = "env" ]; then
            if [[ ! "$env_var" =~ ^LOKI_[A-Z0-9_]+$ ]]; then
                printf 'loki: config validate: ERROR non-allowlisted key %s\n' "$env_var" >&2
                rc=1
                continue
            fi
            if ! loki_env_key_is_known "$env_var"; then
                printf 'loki: config validate: ERROR unknown key %s (not a recognized LOKI_ config var -- typo?)\n' "$env_var" >&2
                rc=1
                continue
            fi
        fi
        # Raw-secret literal is an ERROR in validate.
        if [[ "$value" != *'${'* ]] && loki_value_looks_secret "$value"; then
            printf 'loki: config validate: ERROR %s contains a raw secret literal -- use ${VAR}\n' "$env_var" >&2
            rc=1
            continue
        fi
        # Dry-expand refs; report unresolved.
        if ! expanded="$(loki_expand_refs "$value")"; then
            printf 'loki: config validate: ERROR %s references unresolved ${%s}\n' "$env_var" "$expanded" >&2
            rc=1
            continue
        fi
        # Per-value validation.
        if ! loki_validate_value "$expanded"; then
            printf 'loki: config validate: ERROR %s failed value validation (shell metachar / length / newline)\n' "$env_var" >&2
            rc=1
            continue
        fi
    done <<< "$pairs"

    if [ "$rc" = 0 ]; then
        printf 'loki: config validate: OK -- %s\n' "$path"
    fi
    return "$rc"
}

# Print-only JSON emit (env_var<TAB>value) without export. Used by validate.
_loki_cfg_json_emit() {
    local file="$1"
    if command -v yq >/dev/null 2>&1; then
        local mapping yaml_path env_var value
        for mapping in "${LOKI_CONFIG_MAP[@]}"; do
            yaml_path="${mapping%%:*}"; env_var="${mapping##*:}"
            value="$(yq eval -p=json ".$yaml_path // \"\"" "$file" 2>/dev/null || true)"
            if [ "$value" = "null" ]; then value=""; fi
            if [ -z "$value" ]; then continue; fi
            printf '%s\t%s\n' "$env_var" "$value"
        done
        return 0
    fi
    command -v python3 >/dev/null 2>&1 || return 0
    local map_str="" mapping
    for mapping in "${LOKI_CONFIG_MAP[@]}"; do map_str+="$mapping"$'\n'; done
    _LOKI_CFG_JSON="$file" _LOKI_CFG_MAP="$map_str" python3 -c '
import json, os, sys
def get_nested(d, key):
    cur = d
    for p in key.split("."):
        if isinstance(cur, dict):
            cur = cur.get(p)
        else:
            return None
    return cur
try:
    with open(os.environ["_LOKI_CFG_JSON"]) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
for line in os.environ.get("_LOKI_CFG_MAP", "").splitlines():
    line = line.strip()
    if not line or ":" not in line:
        continue
    path, env_var = line.split(":", 1)
    val = get_nested(data, path)
    if val is None:
        continue
    if isinstance(val, bool):
        val = "true" if val else "false"
    elif isinstance(val, (int, float)):
        val = repr(val) if isinstance(val, float) else str(val)
    elif not isinstance(val, str):
        continue
    if "\t" in val or "\n" in val:
        continue
    sys.stdout.write(env_var + "\t" + val + "\n")
' 2>/dev/null || true
}
