#!/bin/bash
# Show status of all agents in a pool — queries broker + tmux
# Usage: status.sh <session-name>

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

NAME="${1:?Usage: status.sh <session-name>}"
SESSION="$(agent_session_name "$NAME")"
TARGET="$(agent_session_target "$NAME")"
SOCK="$(broker_socket_path "$NAME")"

if ! tmux has-session -t "$TARGET" 2>/dev/null; then
    echo "Error: Session '$SESSION' does not exist"
    exit 1
fi

echo "Agent Pool: $SESSION"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Query broker for structured status if available
BROKER_STATUS=""
if [ -S "$SOCK" ]; then
    BROKER_STATUS=$(bun -e "
const sock = Bun.connect({
    unix: '$SOCK',
    socket: {
        open(s) { s.write(JSON.stringify({ type: 'status' }) + '\n'); },
        data(s, data) { process.stdout.write(data.toString()); s.end(); process.exit(0); },
        error() { process.exit(1); },
    },
});
setTimeout(() => process.exit(1), 2000);
" 2>/dev/null) || true
fi

WINDOWS=$(tmux list-windows -t "$TARGET" -F "#{window_name}")

for WINDOW in $WINDOWS; do
    echo "┌─ $WINDOW"

    if [ -n "$BROKER_STATUS" ]; then
        AGENT_KEY="$WINDOW"
        AGENT_INFO=$(echo "$BROKER_STATUS" | bun -e "
const d = JSON.parse(await Bun.stdin.text());
const a = d.agents?.['$AGENT_KEY'];
if (a) { console.log(a.status + '|' + (a.turn || 0) + '|' + (a.cost || '') + '|' + (a.duration || '')); }
else { console.log('unknown|0||'); }
" 2>/dev/null) || AGENT_INFO="unknown|0||"

        IFS='|' read -r STATUS TURN COST DURATION <<< "$AGENT_INFO"

        case "$STATUS" in
            done)
                echo "│  Status: ✅ DONE (turn $TURN)"
                [ -n "$COST" ] && echo "│  Cost: $COST"
                [ -n "$DURATION" ] && echo "│  Duration: ${DURATION}s"
                ;;
            error)
                echo "│  Status: ❌ ERROR (turn $TURN)"
                ;;
            working)
                echo "│  Status: 🔄 WORKING (turn $TURN)"
                ;;
            idle)
                echo "│  Status: 💤 IDLE (turn $TURN)"
                ;;
            *)
                echo "│  Status: ❓ UNKNOWN"
                ;;
        esac
    else
        echo "│  Status: ❓ UNKNOWN (broker not running)"
    fi

    # Show last meaningful line from pane
    LAST_LINE=$(tmux capture-pane -t "$TARGET:$WINDOW" -p -S -20 2>/dev/null | grep -v '^[[:space:]]*$' | grep -v '────' | grep -v '^~' | tail -1)
    if [ -n "$LAST_LINE" ]; then
        [ ${#LAST_LINE} -gt 60 ] && LAST_LINE="${LAST_LINE:0:60}..."
        echo "│  Last: $LAST_LINE"
    fi

    echo "└────────────────────────────────────────────────────────────────"
    echo ""
done

echo "Commands:"
echo "  Send task:   $SCRIPT_DIR/send.sh $NAME <num> <task>"
echo "  Wait:        $SCRIPT_DIR/wait.sh $NAME <num>"
echo "  Get output:  $SCRIPT_DIR/output.sh $NAME <num>"
echo "  Attach:      tmux attach -t '$SESSION'"
