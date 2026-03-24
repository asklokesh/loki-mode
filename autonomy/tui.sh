#!/usr/bin/env bash
# shellcheck disable=SC2034  # Variables exported for consumers that source this library
#===============================================================================
# Loki Mode TUI Library
# Rich terminal output: spinners, progress bars, tables, boxes, diffs
#
# Inspired by Kiro CLI's TUI (kiro.dev/changelog/cli/1-24)
# Source: arXiv:2602.22518 (RepoMod-Bench) for progress visualization patterns
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/tui.sh"
#   spinner_start "Analyzing codebase..."
#   spinner_stop
#   progress_bar 75 100 "Files processed"
#   draw_box "Title" "Content here"
#===============================================================================

# Guard against double-sourcing
[[ -n "${_LOKI_TUI_LOADED:-}" ]] && return 0
_LOKI_TUI_LOADED=1

# Terminal capabilities
TUI_HAS_COLOR=false
TUI_COLS=80
if [ -t 1 ]; then
    TUI_HAS_COLOR=true
    TUI_COLS=$(tput cols 2>/dev/null || echo 80)
fi

# Unicode box drawing (degrade to ASCII if terminal doesn't support)
if echo -e "\xe2\x94\x80" 2>/dev/null | grep -q "─" 2>/dev/null; then
    BOX_H="─"
    BOX_V="│"
    BOX_TL="┌"
    BOX_TR="┐"
    BOX_BL="└"
    BOX_BR="┘"
    BOX_ML="├"
    BOX_MR="┤"
    BULLET=">"
    CHECK_MARK="[ok]"
    CROSS_MARK="[!!]"
    ARROW_R="->"
    SPINNER_CHARS=("/" "-" "\\" "|")
    BAR_FILL="="
    BAR_EMPTY="-"
else
    BOX_H="-"
    BOX_V="|"
    BOX_TL="+"
    BOX_TR="+"
    BOX_BL="+"
    BOX_BR="+"
    BOX_ML="+"
    BOX_MR="+"
    BULLET=">"
    CHECK_MARK="[ok]"
    CROSS_MARK="[!!]"
    ARROW_R="->"
    SPINNER_CHARS=("/" "-" "\\" "|")
    BAR_FILL="="
    BAR_EMPTY="-"
fi

# Colors (only if terminal supports)
if $TUI_HAS_COLOR; then
    TUI_RED='\033[0;31m'
    TUI_GREEN='\033[0;32m'
    TUI_YELLOW='\033[1;33m'
    TUI_BLUE='\033[0;34m'
    TUI_CYAN='\033[0;36m'
    TUI_MAGENTA='\033[0;35m'
    TUI_BOLD='\033[1m'
    TUI_DIM='\033[2m'
    TUI_NC='\033[0m'
    TUI_UNDERLINE='\033[4m'
    TUI_REVERSE='\033[7m'
    # Model-specific colors (matching dashboard theme)
    TUI_OPUS='\033[0;33m'     # amber
    TUI_SONNET='\033[0;35m'   # purple
    TUI_HAIKU='\033[0;36m'    # teal
else
    TUI_RED='' TUI_GREEN='' TUI_YELLOW='' TUI_BLUE='' TUI_CYAN=''
    TUI_MAGENTA='' TUI_BOLD='' TUI_DIM='' TUI_NC='' TUI_UNDERLINE=''
    TUI_REVERSE='' TUI_OPUS='' TUI_SONNET='' TUI_HAIKU=''
fi

#--- Spinner -------------------------------------------------------------------

_SPINNER_PID=""
_SPINNER_MSG=""

spinner_start() {
    local msg="${1:-Working...}"
    _SPINNER_MSG="$msg"

    # Don't spin in non-interactive terminals
    if ! [ -t 1 ]; then
        echo "$msg"
        return
    fi

    (
        local i=0
        while true; do
            local char="${SPINNER_CHARS[$((i % ${#SPINNER_CHARS[@]}))]}"
            printf "\r${TUI_CYAN}%s${TUI_NC} %s" "$char" "$msg" >&2
            sleep 0.1
            i=$((i + 1))
        done
    ) &
    _SPINNER_PID=$!
    disown $_SPINNER_PID 2>/dev/null
}

spinner_stop() {
    local result="${1:-done}"
    if [ -n "$_SPINNER_PID" ]; then
        kill "$_SPINNER_PID" 2>/dev/null
        wait "$_SPINNER_PID" 2>/dev/null
        _SPINNER_PID=""
    fi
    if [ -t 1 ]; then
        printf "\r${TUI_GREEN}${CHECK_MARK}${TUI_NC} %s ${TUI_DIM}(%s)${TUI_NC}\n" "$_SPINNER_MSG" "$result" >&2
    fi
}

spinner_fail() {
    local reason="${1:-failed}"
    if [ -n "$_SPINNER_PID" ]; then
        kill "$_SPINNER_PID" 2>/dev/null
        wait "$_SPINNER_PID" 2>/dev/null
        _SPINNER_PID=""
    fi
    if [ -t 1 ]; then
        printf "\r${TUI_RED}${CROSS_MARK}${TUI_NC} %s ${TUI_RED}(%s)${TUI_NC}\n" "$_SPINNER_MSG" "$reason" >&2
    fi
}

#--- Progress Bar --------------------------------------------------------------

progress_bar() {
    local current="$1"
    local total="$2"
    local label="${3:-Progress}"
    local width="${4:-40}"

    if [ "$total" -eq 0 ]; then
        return
    fi

    local pct=$((current * 100 / total))
    local filled=$((current * width / total))
    local empty=$((width - filled))

    local bar=""
    for ((i=0; i<filled; i++)); do bar+="$BAR_FILL"; done
    for ((i=0; i<empty; i++)); do bar+="$BAR_EMPTY"; done

    # Color based on percentage
    local color="$TUI_RED"
    if [ "$pct" -ge 80 ]; then color="$TUI_GREEN"
    elif [ "$pct" -ge 50 ]; then color="$TUI_YELLOW"
    elif [ "$pct" -ge 25 ]; then color="$TUI_BLUE"
    fi

    printf "\r  %s ${color}[%s]${TUI_NC} %3d%% (%d/%d)" "$label" "$bar" "$pct" "$current" "$total"
}

progress_bar_done() {
    echo ""  # newline after progress bar
}

#--- Context Window Gauge ------------------------------------------------------

context_gauge() {
    local used="$1"      # tokens used
    local total="$2"     # context window size
    local label="${3:-Context}"
    local width=30

    if [ "$total" -eq 0 ]; then return; fi

    local pct=$((used * 100 / total))
    local filled=$((used * width / total))
    [ "$filled" -gt "$width" ] && filled="$width"
    local empty=$((width - filled))

    # Color: green < 50%, yellow < 80%, red >= 80%
    local color="$TUI_GREEN"
    if [ "$pct" -ge 80 ]; then color="$TUI_RED"
    elif [ "$pct" -ge 50 ]; then color="$TUI_YELLOW"
    fi

    local bar=""
    for ((i=0; i<filled; i++)); do bar+="$BAR_FILL"; done
    for ((i=0; i<empty; i++)); do bar+=" "; done

    local used_fmt
    local total_fmt
    used_fmt=$(format_tokens "$used")
    total_fmt=$(format_tokens "$total")

    echo -e "  ${TUI_BOLD}$label${TUI_NC} ${color}[${bar}]${TUI_NC} ${pct}% (${used_fmt} / ${total_fmt})"
}

format_tokens() {
    local n="$1"
    if [ "$n" -ge 1000000 ]; then
        printf "%.1fM" "$(echo "scale=1; $n / 1000000" | bc 2>/dev/null || echo "$n")"
    elif [ "$n" -ge 1000 ]; then
        printf "%.1fK" "$(echo "scale=1; $n / 1000" | bc 2>/dev/null || echo "$n")"
    else
        echo "$n"
    fi
}

#--- Box Drawing ---------------------------------------------------------------

draw_box() {
    local title="$1"
    shift
    local content="$*"
    local inner_width=$((TUI_COLS - 4))
    [ "$inner_width" -gt 76 ] && inner_width=76

    # Top border with title
    local title_len=${#title}
    local padding=$((inner_width - title_len - 2))
    [ "$padding" -lt 0 ] && padding=0

    local top_line="${BOX_TL}"
    top_line+="${BOX_H} ${TUI_BOLD}${title}${TUI_NC} "
    for ((i=0; i<padding; i++)); do top_line+="${BOX_H}"; done
    top_line+="${BOX_TR}"
    echo -e "$top_line"

    # Content lines
    while IFS= read -r line; do
        local line_plain
        line_plain=$(echo -e "$line" | sed 's/\x1b\[[0-9;]*m//g')
        local line_len=${#line_plain}
        local pad=$((inner_width - line_len))
        [ "$pad" -lt 0 ] && pad=0
        local spaces=""
        for ((i=0; i<pad; i++)); do spaces+=" "; done
        echo -e "${BOX_V} ${line}${spaces} ${BOX_V}"
    done <<< "$content"

    # Bottom border
    local bottom_line="${BOX_BL}"
    for ((i=0; i<inner_width+2; i++)); do bottom_line+="${BOX_H}"; done
    bottom_line+="${BOX_BR}"
    echo -e "$bottom_line"
}

#--- Table Rendering -----------------------------------------------------------

# Usage: table_render "Col1|Col2|Col3" "val1|val2|val3" "val4|val5|val6"
table_render() {
    local header="$1"
    shift
    local rows=("$@")

    # Calculate column widths
    IFS='|' read -ra hcols <<< "$header"
    local ncols=${#hcols[@]}
    local -a widths=()
    for ((i=0; i<ncols; i++)); do
        widths[$i]=${#hcols[$i]}
    done

    for row in "${rows[@]}"; do
        IFS='|' read -ra rcols <<< "$row"
        for ((i=0; i<ncols; i++)); do
            local cell="${rcols[$i]:-}"
            local clen=${#cell}
            if [ "$clen" -gt "${widths[$i]}" ]; then
                widths[$i]=$clen
            fi
        done
    done

    # Header
    local hline="  "
    local sep="  "
    for ((i=0; i<ncols; i++)); do
        local w=${widths[$i]}
        hline+=$(printf "${TUI_BOLD}%-${w}s${TUI_NC}  " "${hcols[$i]}")
        local dashes=""
        for ((j=0; j<w; j++)); do dashes+="-"; done
        sep+=$(printf "%s  " "$dashes")
    done
    echo -e "$hline"
    echo -e "${TUI_DIM}$sep${TUI_NC}"

    # Rows
    for row in "${rows[@]}"; do
        IFS='|' read -ra rcols <<< "$row"
        local rline="  "
        for ((i=0; i<ncols; i++)); do
            local w=${widths[$i]}
            rline+=$(printf "%-${w}s  " "${rcols[$i]:-}")
        done
        echo -e "$rline"
    done
}

#--- Diff Display (colored) ----------------------------------------------------

diff_colored() {
    local file1="$1"
    local file2="$2"

    if command -v delta &>/dev/null; then
        delta "$file1" "$file2"
    elif command -v diff &>/dev/null; then
        diff -u "$file1" "$file2" | while IFS= read -r line; do
            case "$line" in
                ---*) echo -e "${TUI_BOLD}${line}${TUI_NC}" ;;
                +++*) echo -e "${TUI_BOLD}${line}${TUI_NC}" ;;
                @@*) echo -e "${TUI_CYAN}${line}${TUI_NC}" ;;
                +*) echo -e "${TUI_GREEN}${line}${TUI_NC}" ;;
                -*) echo -e "${TUI_RED}${line}${TUI_NC}" ;;
                *) echo "$line" ;;
            esac
        done
    fi
}

# Inline diff from string
diff_inline() {
    local label="$1"
    local old_val="$2"
    local new_val="$3"
    echo -e "  ${label}: ${TUI_RED}${old_val}${TUI_NC} ${ARROW_R} ${TUI_GREEN}${new_val}${TUI_NC}"
}

#--- Status Line ---------------------------------------------------------------

status_line() {
    local phase="$1"
    local iteration="$2"
    local model="$3"
    local context_pct="${4:-0}"

    # Model color
    local model_color="$TUI_NC"
    case "$model" in
        *opus*) model_color="$TUI_OPUS" ;;
        *sonnet*) model_color="$TUI_SONNET" ;;
        *haiku*) model_color="$TUI_HAIKU" ;;
    esac

    # Context color
    local ctx_color="$TUI_GREEN"
    if [ "$context_pct" -ge 80 ]; then ctx_color="$TUI_RED"
    elif [ "$context_pct" -ge 50 ]; then ctx_color="$TUI_YELLOW"
    fi

    printf "${TUI_DIM}[${TUI_NC}${TUI_BOLD}%s${TUI_NC}${TUI_DIM}]${TUI_NC} " "$phase"
    printf "iter:%s " "$iteration"
    printf "${model_color}%s${TUI_NC} " "$model"
    printf "${ctx_color}ctx:%d%%${TUI_NC}" "$context_pct"
    echo ""
}

#--- Section Headers -----------------------------------------------------------

section_header() {
    local title="$1"
    local width=${2:-$TUI_COLS}
    [ "$width" -gt 80 ] && width=80

    echo ""
    echo -e "${TUI_BOLD}${title}${TUI_NC}"
    local line=""
    for ((i=0; i<${#title}; i++)); do line+="${BOX_H}"; done
    echo -e "${TUI_DIM}${line}${TUI_NC}"
}

#--- Token Cost Display --------------------------------------------------------

display_token_cost() {
    local model="$1"
    local input_tokens="$2"
    local output_tokens="$3"

    # Pricing per 1M tokens (March 2026 rates)
    local input_rate=0
    local output_rate=0
    case "$model" in
        *opus*)   input_rate=15.0;  output_rate=75.0 ;;
        *sonnet*) input_rate=3.0;   output_rate=15.0 ;;
        *haiku*)  input_rate=0.25;  output_rate=1.25 ;;
        *gpt-4o*) input_rate=2.5;   output_rate=10.0 ;;
        *gpt-4o-mini*) input_rate=0.15; output_rate=0.6 ;;
        *)        input_rate=3.0;   output_rate=15.0 ;;  # default sonnet-like
    esac

    local input_cost
    local output_cost
    input_cost=$(echo "scale=4; $input_tokens * $input_rate / 1000000" | bc 2>/dev/null || echo "0")
    output_cost=$(echo "scale=4; $output_tokens * $output_rate / 1000000" | bc 2>/dev/null || echo "0")
    local total_cost
    total_cost=$(echo "scale=4; $input_cost + $output_cost" | bc 2>/dev/null || echo "0")

    local in_fmt out_fmt
    in_fmt=$(format_tokens "$input_tokens")
    out_fmt=$(format_tokens "$output_tokens")

    echo -e "  ${TUI_DIM}Input:${TUI_NC}  ${in_fmt} tokens  (\$${input_cost})"
    echo -e "  ${TUI_DIM}Output:${TUI_NC} ${out_fmt} tokens  (\$${output_cost})"
    echo -e "  ${TUI_DIM}Total:${TUI_NC}  \$${total_cost}"
}

#--- Tree Display --------------------------------------------------------------

# Display a directory tree (simple, no external deps)
tree_display() {
    local dir="${1:-.}"
    local prefix="${2:-}"
    local depth="${3:-3}"

    if [ "$depth" -le 0 ]; then
        echo "${prefix}..."
        return
    fi

    local items=()
    while IFS= read -r item; do
        [ -n "$item" ] && items+=("$item")
    done < <(ls -1 "$dir" 2>/dev/null | grep -v '^\.' | head -20)

    local count=${#items[@]}
    local i=0
    for item in "${items[@]}"; do
        i=$((i + 1))
        local connector="${BOX_ML}${BOX_H}${BOX_H}"
        local next_prefix="${prefix}${BOX_V}   "
        if [ "$i" -eq "$count" ]; then
            connector="${BOX_BL}${BOX_H}${BOX_H}"
            next_prefix="${prefix}    "
        fi

        if [ -d "$dir/$item" ]; then
            echo -e "${prefix}${connector} ${TUI_BOLD}${item}/${TUI_NC}"
            tree_display "$dir/$item" "$next_prefix" $((depth - 1))
        else
            echo -e "${prefix}${connector} ${item}"
        fi
    done
}

#--- Notification Banner -------------------------------------------------------

banner_info() {
    echo -e "${TUI_BLUE}${BOX_H}${BOX_H}${BOX_H} ${TUI_BOLD}$*${TUI_NC}"
}

banner_warn() {
    echo -e "${TUI_YELLOW}${BOX_H}${BOX_H}${BOX_H} ${TUI_BOLD}$*${TUI_NC}"
}

banner_error() {
    echo -e "${TUI_RED}${BOX_H}${BOX_H}${BOX_H} ${TUI_BOLD}$*${TUI_NC}"
}

banner_success() {
    echo -e "${TUI_GREEN}${BOX_H}${BOX_H}${BOX_H} ${TUI_BOLD}$*${TUI_NC}"
}
