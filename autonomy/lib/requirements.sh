#!/usr/bin/env bash
# requirements.sh -- bash evaluator for the shared setup requirements table
# (autonomy/lib/setup-requirements.json). Used by the minimal `loki doctor --json`
# fallback that runs when the Bun doctor cannot (for example Bun is absent). The Bun
# doctor uses loki-ts/src/util/requirements.ts on the same table.
# Presence only: unlike the Bun evaluator this does not compare versions.
# Output shape matches the "requirements" key of the Bun doctor JSON.

# _loki_req_sdk_binary_present <skill_dir>: an executable SDK platform binary exists in
# an installed node_modules (mirrors detect_bundled_sdk_provider in provider-offer.sh).
_loki_req_sdk_binary_present() {
    local root="$1" nm f
    local roots=()
    if [ -n "${LOKI_SDK_NODE_MODULES:-}" ]; then
        roots=("$LOKI_SDK_NODE_MODULES")
    else
        roots=("$root/node_modules" "$root/loki-ts/node_modules" "$root/.." "$root/../..")
    fi
    for nm in "${roots[@]}"; do
        for f in "$nm"/@anthropic-ai/claude-agent-sdk-*/claude; do
            [ -x "$f" ] && return 0
        done
    done
    return 1
}

# loki_requirements_json <skill_dir>: print the requirements report as one JSON object.
loki_requirements_json() {
    local root="$1" table="$1/autonomy/lib/setup-requirements.json" statuses="" id kind target values st v
    if [ ! -f "$table" ] || ! command -v jq >/dev/null 2>&1; then
        printf 'null\n'
        return 0
    fi
    while IFS=$'\t' read -r id kind target values; do
        st=missing
        case "$kind" in
            command) command -v "$target" >/dev/null 2>&1 && st=present ;;
            env_any)
                for v in ${target//,/ }; do [ -n "${!v:-}" ] && st=present; done ;;
            env_value)
                for v in ${target//,/ }; do
                    case ",${values}," in *",${!v:-},"*) [ -n "${!v:-}" ] && st=present ;; esac
                done ;;
            sdk_binary) _loki_req_sdk_binary_present "$root" && st=present ;;
        esac
        statuses="${statuses}${id} ${st}"$'\n'
    done < <(jq -r '.requirements[] | [.id, .kind, (.target | if type == "array" then join(",") else . end), ((.values // []) | join(","))] | @tsv' "$table")

    jq -n --rawfile st <(printf '%s' "$statuses") --slurpfile t "$table" '
      ($st | split("\n") | map(select(length > 0) | split(" ") | {(.[0]): .[1]}) | add) as $s
      | $t[0] as $tab
      | {paths: [ $tab.paths[] as $p
          | ([ $tab.requirements[] | select(.path == $p.id)
               | {id, label, level, status: $s[.id], detail: (if $s[.id] == "present" then null else "not found by presence check" end), fix} ]) as $items
          | ([ $items[] | select(.level == "required") ]) as $req
          | {id: $p.id, title: $p.title,
             ready: (if ($req | length) > 0 then ($req | all(.status == "present")) else ($items | any(.status == "present")) end),
             items: $items} ]}
      | . + {first_task_ready: ((.paths[] | select(.id == "common") | .ready) and ([.paths[] | select(.id != "common") | .ready] | any))}'
}
