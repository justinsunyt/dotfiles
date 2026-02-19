#!/bin/bash
# Kill agent(s) or entire pool, including broker
# Usage: kill.sh <session-name> [agent-number]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

NAME="${1:?Usage: kill.sh <session-name> [agent-number]}"
AGENT_NUM="${2:-}"
SESSION="$(agent_session_name "$NAME")"
TARGET="$(agent_session_target "$NAME")"
SOCK="$(broker_socket_path "$NAME")"
PID_FILE="$(broker_pid_path "$NAME")"

if ! tmux has-session -t "$TARGET" 2>/dev/null; then
    echo "Error: Session '$SESSION' does not exist"
    exit 1
fi

if [ -n "$AGENT_NUM" ]; then
    WINDOW_NAME="agent-$AGENT_NUM"

    if ! tmux list-windows -t "$TARGET" -F "#{window_name}" | grep -q "^$WINDOW_NAME$"; then
        echo "Error: Window '$WINDOW_NAME' does not exist in session '$SESSION'"
        exit 1
    fi

    tmux send-keys -t "$TARGET:$WINDOW_NAME" C-c C-c
    sleep 0.5
    tmux send-keys -t "$TARGET:$WINDOW_NAME" C-d
    sleep 0.5
    tmux kill-window -t "$TARGET:$WINDOW_NAME" 2>/dev/null || true

    echo "✓ Killed $SESSION:$WINDOW_NAME"

    REMAINING=$(tmux list-windows -t "$TARGET" 2>/dev/null | wc -l || echo "0")
    if [ "$REMAINING" -eq 0 ]; then
        tmux kill-session -t "$TARGET" 2>/dev/null || true
        echo "✓ Session '$SESSION' was empty and has been removed"
        if [ -f "$PID_FILE" ]; then
            kill "$(cat "$PID_FILE")" 2>/dev/null || true
            rm -f "$PID_FILE"
        fi
        rm -f "$SOCK"
    fi
else
    WINDOWS=$(tmux list-windows -t "$TARGET" -F "#{window_name}" 2>/dev/null || echo "")

    for WINDOW in $WINDOWS; do
        tmux send-keys -t "$TARGET:$WINDOW" C-c C-c 2>/dev/null || true
    done
    sleep 0.5
    for WINDOW in $WINDOWS; do
        tmux send-keys -t "$TARGET:$WINDOW" C-d 2>/dev/null || true
    done
    sleep 0.5

    tmux kill-session -t "$TARGET" 2>/dev/null || true
    echo "✓ Killed session '$SESSION' and all agents"

    if [ -S "$SOCK" ]; then
        bun -e "
const sock = Bun.connect({
    unix: '$SOCK',
    socket: {
        open(s) { s.write(JSON.stringify({ type: 'shutdown' }) + '\n'); },
        data(s) { s.end(); process.exit(0); },
        error() { process.exit(0); },
    },
});
setTimeout(() => process.exit(0), 1000);
" 2>/dev/null || true
        echo "✓ Broker shut down"
    fi

    if [ -f "$PID_FILE" ]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    rm -f "$SOCK"
fi
