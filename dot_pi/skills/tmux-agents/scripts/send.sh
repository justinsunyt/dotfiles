#!/bin/bash
# Send a task to a specific agent. Interrupts if agent is currently working.
# Usage: send.sh <session-name> <agent-number> <task>

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

NAME="${1:?Usage: send.sh <session-name> <agent-number> <task>}"
AGENT_NUM="${2:?Usage: send.sh <session-name> <agent-number> <task>}"
shift 2
TASK="$*"

if [ -z "$TASK" ]; then
    echo "Error: task cannot be empty"
    exit 1
fi

SESSION="$(agent_session_name "$NAME")"
TARGET="$(agent_session_target "$NAME")"
SOCK="$(broker_socket_path "$NAME")"
WINDOW_NAME="agent-$AGENT_NUM"

if ! tmux has-session -t "$TARGET" 2>/dev/null; then
    echo "Error: Session '$SESSION' does not exist"
    exit 1
fi

if ! tmux list-windows -t "$TARGET" -F "#{window_name}" | grep -q "^$WINDOW_NAME$"; then
    echo "Error: Window '$WINDOW_NAME' does not exist in session '$SESSION'"
    echo "Available windows:"
    tmux list-windows -t "$TARGET" -F "  #{window_name}"
    exit 1
fi

# Cancel current task if agent is working
if [ -S "$SOCK" ]; then
    AGENT_STATUS=$(bun -e "
const sock = Bun.connect({
    unix: '$SOCK',
    socket: {
        open(s) { s.write(JSON.stringify({ type: 'status' }) + '\n'); },
        data(s, data) {
            const d = JSON.parse(data.toString());
            const a = d.agents?.['agent-$AGENT_NUM'];
            console.log(a?.status || 'unknown');
            s.end(); process.exit(0);
        },
        error() { console.log('unknown'); process.exit(0); },
    },
});
setTimeout(() => { console.log('unknown'); process.exit(0); }, 2000);
" 2>/dev/null) || AGENT_STATUS="unknown"

    if [ "$AGENT_STATUS" = "working" ]; then
        # Tell broker to cancel — notifies any waiters
        bun -e "
const sock = Bun.connect({
    unix: '$SOCK',
    socket: {
        open(s) { s.write(JSON.stringify({ type: 'cancel', agent: $AGENT_NUM }) + '\n'); },
        data(s) { s.end(); process.exit(0); },
        error() { process.exit(0); },
    },
});
setTimeout(() => process.exit(0), 2000);
" 2>/dev/null || true

        # Send Escape to interrupt pi
        tmux send-keys -t "$TARGET:$WINDOW_NAME" Escape
        sleep 0.5
        echo "✓ Interrupted agent-$AGENT_NUM"
    fi
fi

# Send the task
tmux send-keys -t "$TARGET:$WINDOW_NAME" "$TASK" C-m

echo "✓ Sent task to $SESSION:$WINDOW_NAME"
