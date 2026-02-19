#!/bin/bash
# Get output from an agent — reads transcript file, falls back to tmux pane
# Usage: output.sh <session-name> <agent-number> [--pane] [--lines N] [--full]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

NAME="${1:?Usage: output.sh <session-name> <agent-number> [--pane] [--lines N] [--full]}"
AGENT_NUM="${2:?Usage: output.sh <session-name> <agent-number> [--pane] [--lines N] [--full]}"
shift 2

LINES=100
FULL=false
PANE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --lines) LINES="$2"; shift 2 ;;
        --full) FULL=true; shift ;;
        --pane) PANE=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

TARGET="$(agent_session_target "$NAME")"
SESSION="$(agent_session_name "$NAME")"
WINDOW_NAME="agent-$AGENT_NUM"
TRANSCRIPT="/tmp/pi-agents/${NAME}/agent-${AGENT_NUM}.transcript"

if [ "$PANE" = true ] || [ ! -f "$TRANSCRIPT" ]; then
    if ! tmux has-session -t "$TARGET" 2>/dev/null; then
        echo "Error: Session '$SESSION' does not exist" >&2
        exit 1
    fi
    if ! tmux list-windows -t "$TARGET" -F "#{window_name}" | grep -q "^$WINDOW_NAME$"; then
        echo "Error: Window '$WINDOW_NAME' does not exist in session '$SESSION'" >&2
        exit 1
    fi

    if [ "$PANE" != true ] && [ ! -f "$TRANSCRIPT" ]; then
        echo "# No transcript yet, showing raw pane output:" >&2
    fi

    if [ "$FULL" = true ]; then
        tmux capture-pane -t "$TARGET:$WINDOW_NAME" -p -S -
    else
        tmux capture-pane -t "$TARGET:$WINDOW_NAME" -p -S "-$LINES"
    fi
else
    if [ "$FULL" = true ]; then
        cat "$TRANSCRIPT"
    else
        tail -n "$LINES" "$TRANSCRIPT"
    fi
fi
