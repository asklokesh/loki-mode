#!/usr/bin/env bash
# Loki Mode Voice Input Support (v1.0.0)
# Enables voice-to-text for PRD dictation and command input
#
# Usage:
#   ./autonomy/voice.sh listen        - Listen for voice input
#   ./autonomy/voice.sh speak MESSAGE - Text-to-speech output
#   ./autonomy/voice.sh dictate FILE  - Dictate to file
#   ./autonomy/voice.sh status        - Check voice capabilities
#
# Requires: macOS with Dictation enabled, or Whisper API

set -euo pipefail

LOKI_DIR="${LOKI_DIR:-.loki}"

# Colors (only if terminal supports them)
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

log() { echo -e "${BLUE}[loki-voice]${NC} $*"; }
log_success() { echo -e "${GREEN}[loki-voice]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[loki-voice]${NC} $*"; }
log_error() { echo -e "${RED}[loki-voice]${NC} $*" >&2; }

# Detect platform and available voice tools
detect_platform() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        echo "windows"
    else
        echo "unknown"
    fi
}

# Check if voice input is available
check_voice_input() {
    local platform
    platform=$(detect_platform)

    case "$platform" in
        macos)
            # Check if dictation is enabled
            if defaults read com.apple.speech.recognition.AppleSpeechRecognition.prefs DictationIMMEnabled 2>/dev/null | grep -q "1"; then
                echo "macos-dictation"
            elif command -v whisper &>/dev/null; then
                echo "whisper"
            elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
                echo "whisper-api"
            else
                echo "none"
            fi
            ;;
        linux)
            if command -v whisper &>/dev/null; then
                echo "whisper"
            elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
                echo "whisper-api"
            elif command -v arecord &>/dev/null && command -v vosk &>/dev/null; then
                echo "vosk"
            else
                echo "none"
            fi
            ;;
        *)
            echo "none"
            ;;
    esac
}

# Check if text-to-speech is available
check_voice_output() {
    local platform
    platform=$(detect_platform)

    case "$platform" in
        macos)
            if command -v say &>/dev/null; then
                echo "say"
            else
                echo "none"
            fi
            ;;
        linux)
            if command -v espeak &>/dev/null; then
                echo "espeak"
            elif command -v festival &>/dev/null; then
                echo "festival"
            else
                echo "none"
            fi
            ;;
        *)
            echo "none"
            ;;
    esac
}

# Text-to-speech output
speak() {
    local message="$1"
    local output_method
    output_method=$(check_voice_output)

    case "$output_method" in
        say)
            say -v "Samantha" "$message" 2>/dev/null || say "$message"
            ;;
        espeak)
            espeak "$message"
            ;;
        festival)
            echo "$message" | festival --tts
            ;;
        none)
            log_warn "No text-to-speech available, printing instead"
            echo "$message"
            ;;
    esac
}

# Temp file cleanup
declare -a TEMP_FILES
TEMP_FILES=()
cleanup_temp_files() {
    if [[ ${#TEMP_FILES[@]} -gt 0 ]]; then
        for f in "${TEMP_FILES[@]}"; do
            rm -f "$f" 2>/dev/null
        done
    fi
}
trap cleanup_temp_files EXIT

# Create secure temp file
make_temp_file() {
    local suffix="${1:-.tmp}"
    local temp_file
    temp_file=$(mktemp "/tmp/loki-voice-XXXXXX$suffix")
    TEMP_FILES+=("$temp_file")
    echo "$temp_file"
}

# Record audio using macOS
record_audio_macos() {
    local output_file="$1"
    local duration="${2:-10}"

    log "Recording for ${duration} seconds... Press Ctrl+C to stop early"

    # Use sox or ffmpeg
    if command -v sox &>/dev/null; then
        sox -d -r 16000 -c 1 -b 16 "$output_file" trim 0 "$duration" 2>/dev/null
    elif command -v ffmpeg &>/dev/null; then
        ffmpeg -f avfoundation -i ":0" -t "$duration" -ar 16000 -ac 1 "$output_file" -y 2>/dev/null
    else
        log_error "No audio recording tool found. Install sox: brew install sox"
        return 1
    fi
}

# Record audio using Linux
record_audio_linux() {
    local output_file="$1"
    local duration="${2:-10}"

    log "Recording for ${duration} seconds... Press Ctrl+C to stop early"

    # Use sox, arecord, or ffmpeg
    if command -v sox &>/dev/null; then
        sox -d -r 16000 -c 1 -b 16 "$output_file" trim 0 "$duration" 2>/dev/null
    elif command -v arecord &>/dev/null; then
        arecord -f S16_LE -r 16000 -c 1 -d "$duration" "$output_file" 2>/dev/null
    elif command -v ffmpeg &>/dev/null; then
        ffmpeg -f alsa -i default -t "$duration" -ar 16000 -ac 1 "$output_file" -y 2>/dev/null
    else
        log_error "No audio recording tool found. Install: apt install sox alsa-utils"
        return 1
    fi
}

# Record audio (platform-aware)
record_audio() {
    local platform
    platform=$(detect_platform)

    case "$platform" in
        macos)
            record_audio_macos "$@"
            ;;
        linux)
            record_audio_linux "$@"
            ;;
        *)
            log_error "Audio recording not supported on $platform"
            return 1
            ;;
    esac
}

# Transcribe audio using Whisper API
transcribe_whisper_api() {
    local audio_file="$1"

    if [[ -z "${OPENAI_API_KEY:-}" ]]; then
        log_error "OPENAI_API_KEY not set"
        return 1
    fi

    local response
    response=$(curl -s -X POST "https://api.openai.com/v1/audio/transcriptions" \
        -H "Authorization: Bearer $OPENAI_API_KEY" \
        -F "file=@$audio_file" \
        -F "model=whisper-1" \
        -F "language=en")

    echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('text', ''))"
}

# Transcribe audio using local Whisper
transcribe_whisper_local() {
    local audio_file="$1"
    local output_dir
    output_dir=$(dirname "$audio_file")

    if ! command -v whisper &>/dev/null; then
        log_error "Whisper not installed. Run: pip install openai-whisper"
        return 1
    fi

    # Specify output directory to ensure output goes to same location as audio
    whisper "$audio_file" --model base --language en --output_format txt --output_dir "$output_dir" 2>/dev/null
    local txt_file="${audio_file%.wav}.txt"
    if [[ -f "$txt_file" ]]; then
        cat "$txt_file"
        rm -f "$txt_file"
    else
        # Fallback: check current directory (older whisper versions)
        local basename_txt
        basename_txt=$(basename "${audio_file%.wav}.txt")
        if [[ -f "$basename_txt" ]]; then
            cat "$basename_txt"
            rm -f "$basename_txt"
        fi
    fi
}

# Listen for voice input
listen() {
    local input_method
    input_method=$(check_voice_input)

    log "Voice input method: $input_method"

    case "$input_method" in
        macos-dictation)
            log "Starting macOS Dictation..."
            speak "Starting dictation. Press twice on Function key to begin, then speak your PRD."

            # Open a dialog for dictation
            osascript <<'EOF'
tell application "System Events"
    display dialog "Click OK then press Fn twice to start dictation" buttons {"Cancel", "OK"} default button "OK"
end tell
EOF
            # Wait for user to dictate
            log "Waiting for dictation input..."
            log "Press Fn twice to toggle dictation on/off"

            # Use a temporary file approach
            local temp_file
            temp_file=$(make_temp_file .txt)
            # Escape single quotes in temp_file for safe embedding in AppleScript
            local escaped_temp_file="${temp_file//\'/\'\\\'\'}"
            osascript <<EOF
tell application "System Events"
    set userInput to text returned of (display dialog "Dictate or type your PRD:" default answer "" buttons {"Cancel", "OK"} default button "OK" with title "Loki Mode Voice Input")
    do shell script "cat > '${escaped_temp_file}'" & " <<HEREDOC
" & userInput & "
HEREDOC"
end tell
EOF
            if [[ -f "$temp_file" ]]; then
                cat "$temp_file"
                rm -f "$temp_file"
            fi
            ;;

        whisper-api)
            log "Using Whisper API for transcription"
            local audio_file
            audio_file=$(make_temp_file .wav)

            speak "Recording will start now. Speak your requirements."
            record_audio "$audio_file" 30

            log "Transcribing..."
            transcribe_whisper_api "$audio_file"
            ;;

        whisper)
            log "Using local Whisper for transcription"
            local audio_file
            audio_file=$(make_temp_file .wav)

            speak "Recording will start now. Speak your requirements."
            record_audio "$audio_file" 30

            log "Transcribing locally..."
            transcribe_whisper_local "$audio_file"
            ;;

        none)
            log_error "No voice input method available"
            log "Options:"
            log "  1. Enable macOS Dictation: System Settings > Keyboard > Dictation"
            log "  2. Set OPENAI_API_KEY for Whisper API"
            log "  3. Install local Whisper: pip install openai-whisper"
            return 1
            ;;
    esac
}

# Dictate to a file
dictate_to_file() {
    local output_file="$1"

    log "Dictating to: $output_file"
    speak "Ready to create a PRD. I'll guide you through the sections."

    local content=""

    # Guide through PRD sections
    speak "First, what is the name of your project?"
    local project_name
    project_name=$(listen)
    content="# $project_name\n\n"

    speak "Great. Now describe the overview of your project."
    local overview
    overview=$(listen)
    content+="## Overview\n$overview\n\n"

    speak "Now list your requirements. Say done when finished."
    content+="## Requirements\n"

    while true; do
        local requirement
        requirement=$(listen)

        # Use tr for bash 3.2 compatibility (macOS default)
        local requirement_lower
        requirement_lower=$(printf '%s' "$requirement" | tr '[:upper:]' '[:lower:]')
        if [[ "$requirement_lower" == *"done"* ]] || [[ "$requirement_lower" == *"finish"* ]]; then
            break
        fi

        content+="- [ ] $requirement\n"
        speak "Got it. Next requirement, or say done."
    done

    speak "What tech stack do you want to use?"
    local tech_stack
    tech_stack=$(listen)
    content+="\n## Tech Stack\n$tech_stack\n"

    # Write to file
    echo -e "$content" > "$output_file"

    speak "PRD created at $output_file"
    log_success "PRD saved to: $output_file"
    echo "$output_file"
}

# Show voice capabilities status
status() {
    local platform
    platform=$(detect_platform)

    echo "=== Loki Mode Voice Status ==="
    echo ""
    echo "Platform: $platform"
    echo ""

    echo "Voice Input:"
    local input_method
    input_method=$(check_voice_input)
    case "$input_method" in
        macos-dictation)
            echo "  [OK] macOS Dictation enabled"
            ;;
        whisper-api)
            echo "  [OK] Whisper API available (OPENAI_API_KEY set)"
            ;;
        whisper)
            echo "  [OK] Local Whisper installed"
            ;;
        vosk)
            echo "  [OK] Vosk speech recognition available"
            ;;
        none)
            echo "  [--] No voice input available"
            echo "  Recommendations:"
            echo "    - macOS: Enable Dictation in System Settings > Keyboard"
            echo "    - Set OPENAI_API_KEY for Whisper API"
            echo "    - pip install openai-whisper for local transcription"
            ;;
    esac
    echo ""

    echo "Voice Output (TTS):"
    local output_method
    output_method=$(check_voice_output)
    case "$output_method" in
        say)
            echo "  [OK] macOS 'say' command available"
            ;;
        espeak)
            echo "  [OK] eSpeak available"
            ;;
        festival)
            echo "  [OK] Festival TTS available"
            ;;
        none)
            echo "  [--] No TTS available"
            ;;
    esac
    echo ""

    echo "Audio Recording:"
    if command -v sox &>/dev/null; then
        echo "  [OK] sox installed"
    elif command -v ffmpeg &>/dev/null; then
        echo "  [OK] ffmpeg installed (fallback)"
    else
        echo "  [--] No recording tool (install sox: brew install sox)"
    fi
}

# CLI entry point
main() {
    local command="${1:-help}"
    shift || true

    case "$command" in
        listen)
            listen
            ;;
        speak)
            if [[ $# -eq 0 ]]; then
                log_error "Usage: voice.sh speak MESSAGE"
                exit 1
            fi
            speak "$*"
            ;;
        dictate)
            local output="${1:-prd-voice.md}"
            dictate_to_file "$output"
            ;;
        status)
            status
            ;;
        help|--help|-h)
            echo "Loki Mode Voice Input"
            echo ""
            echo "Usage: voice.sh <command> [options]"
            echo ""
            echo "Commands:"
            echo "  listen          Listen for voice input and return text"
            echo "  speak MESSAGE   Text-to-speech output"
            echo "  dictate [FILE]  Guided PRD dictation (default: prd-voice.md)"
            echo "  status          Show voice capabilities"
            echo ""
            echo "Environment:"
            echo "  OPENAI_API_KEY  Required for Whisper API transcription"
            echo ""
            echo "Setup:"
            echo "  macOS: Enable Dictation in System Settings > Keyboard"
            echo "  Linux: Install sox and whisper: apt install sox && pip install openai-whisper"
            ;;
        *)
            log_error "Unknown command: $command"
            echo "Run 'voice.sh help' for usage"
            exit 1
            ;;
    esac
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
