#!/bin/bash
# Send the same task to all agents in a pool
# Usage: broadcast.sh <session-name> <task>

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

NAME="${1:?Usage: broadcast.sh <session-name> <task>}"
shift
TASK="$*"

if [ -z "$TASK" ]; then
    echo "Error: task cannot be empty"
    exit 1
fi

SESSION="$(agent_session_name "$NAME")"
TARGET="$(agent_session_target "$NAME")"

if ! tmux has-session -t "$TARGET" 2>/dev/null; then
    echo "Error: Session '$SESSION' does not exist"
    exit 1
fi

WINDOWS=$(tmux list-windows -t "$TARGET" -F "#{window_name}" | grep "^agent-" || echo "")

if [ -z "$WINDOWS" ]; then
    echo "Error: No agent windows found in session '$SESSION'"
    exit 1
fi

COUNT=0
for WINDOW in $WINDOWS; do
    tmux send-keys -t "$TARGET:$WINDOW" "$TASK" C-m
    COUNT=$((COUNT + 1))
    echo "✓ Sent to $SESSION:$WINDOW"
done

echo ""
echo "✓ Broadcasted task to $COUNT agent(s)"
