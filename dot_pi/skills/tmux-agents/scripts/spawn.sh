#!/bin/bash
# Spawn multiple pi agents in a tmux session with broker
# Usage: spawn.sh <session-name> <count> [pi-args...]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

NAME="${1:?Usage: spawn.sh <session-name> <count> [pi-args...]}"
COUNT="${2:?Usage: spawn.sh <session-name> <count> [pi-args...]}"
shift 2
PI_ARGS="--provider anthropic --model claude-opus-4-5 --thinking medium $*"

# Validate count
if [[ ! "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 10 ]; then
    echo "Error: count must be a number between 1 and 10"
    exit 1
fi

SESSION="$(agent_session_name "$NAME")"
TARGET="$(agent_session_target "$NAME")"
SOCK="$(broker_socket_path "$NAME")"
PID_FILE="$(broker_pid_path "$NAME")"

# Check if session already exists
if tmux has-session -t "$TARGET" 2>/dev/null; then
    echo "Error: Session '$SESSION' already exists"
    echo "Use: $SCRIPT_DIR/kill.sh $NAME"
    exit 1
fi

WORK_DIR="$(pwd)"

# Start broker daemon
echo "Starting broker..."
BROKER_LOG="${BROKER_SOCK_DIR}/${NAME}.log"
nohup bun "$SCRIPT_DIR/broker.ts" "$NAME" "$SOCK" > "$BROKER_LOG" 2>&1 &
BROKER_PID=$!
disown $BROKER_PID 2>/dev/null || true
echo "$BROKER_PID" > "$PID_FILE"

# Wait for socket to appear
for i in $(seq 1 20); do
    [ -S "$SOCK" ] && break
    sleep 0.1
done

if [ ! -S "$SOCK" ]; then
    echo "Error: Broker failed to start"
    kill "$BROKER_PID" 2>/dev/null || true
    exit 1
fi

echo "✓ Broker running (pid $BROKER_PID, socket $SOCK)"

# Create session with first agent
echo "Creating session '$SESSION' with $COUNT agent(s)..."
tmux new-session -d -s "$SESSION" -n "agent-1" -c "$WORK_DIR"
tmux send-keys -t "$TARGET:agent-1" "PI_AGENT_BROKER_SOCK='$SOCK' PI_AGENT_NUM=1 PI_AGENT_SESSION='$NAME' pi $PI_ARGS" C-m

# Create additional agent windows
if [ "$COUNT" -gt 1 ]; then
    for i in $(seq 2 "$COUNT"); do
        tmux new-window -t "$TARGET" -n "agent-$i" -c "$WORK_DIR"
        tmux send-keys -t "$TARGET:agent-$i" "PI_AGENT_BROKER_SOCK='$SOCK' PI_AGENT_NUM=$i PI_AGENT_SESSION='$NAME' pi $PI_ARGS" C-m
    done
fi

echo "✓ Spawned $COUNT agent(s) in session '$SESSION'"
echo ""
echo "Windows:"
tmux list-windows -t "$TARGET" -F "  #{window_index}: #{window_name}"
echo ""
echo "Commands:"
echo "  Attach:  tmux attach -t '$SESSION'"
echo "  Send:    $SCRIPT_DIR/send.sh $NAME <agent-num> <task>"
echo "  Status:  $SCRIPT_DIR/status.sh $NAME"
echo "  Wait:    $SCRIPT_DIR/wait.sh $NAME <agent-num>"
echo "  Kill:    $SCRIPT_DIR/kill.sh $NAME"
