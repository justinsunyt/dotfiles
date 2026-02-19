#!/bin/bash
# List all tmux agent sessions
# Usage: list.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "Active Agent Pools"
echo "════════════════════════════════════════════════════════════════"
echo ""

SESSIONS=$(tmux list-sessions -F "#{session_name}" 2>/dev/null || echo "")

if [ -z "$SESSIONS" ]; then
    echo "No active tmux sessions found."
    exit 0
fi

FOUND=0

while IFS= read -r SESSION; do
    # Only show sessions with our prefix
    if [[ "$SESSION" == "[agent] "* ]]; then
        FOUND=1
        NAME="${SESSION#\[agent\] }"
        AGENT_WINDOWS=$(tmux list-windows -t "$SESSION" -F "#{window_name}" 2>/dev/null | grep -c "^agent-" || true)
        SOCK="$(broker_socket_path "$NAME")"

        BROKER_STATUS="❌ not running"
        [ -S "$SOCK" ] && BROKER_STATUS="✅ running"

        echo "📦 $SESSION ($AGENT_WINDOWS agents) — broker: $BROKER_STATUS"
        tmux list-windows -t "$SESSION" -F "   └─ #{window_name}" | head -10
        [ "$AGENT_WINDOWS" -gt 10 ] && echo "   └─ ... and $((AGENT_WINDOWS - 10)) more"
        echo ""
    fi
done <<< "$SESSIONS"

if [ "$FOUND" -eq 0 ]; then
    echo "No agent pools found."
    echo ""
    echo "Create one with:"
    echo "  $SCRIPT_DIR/spawn.sh <session-name> <count> [pi-args...]"
fi
