#!/bin/bash
# Wait for an agent to complete its current task via broker socket
# Usage: wait.sh <session-name> <agent-number> [--timeout N]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

NAME="${1:?Usage: wait.sh <session-name> <agent-number> [--timeout N]}"
AGENT_NUM="${2:?Usage: wait.sh <session-name> <agent-number> [--timeout N]}"
shift 2

TIMEOUT=600

while [[ $# -gt 0 ]]; do
    case $1 in
        --timeout) TIMEOUT="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

SOCK="$(broker_socket_path "$NAME")"

if [ ! -S "$SOCK" ]; then
    echo "Error: No broker socket at $SOCK — is the session running?" >&2
    exit 1
fi

echo "Waiting for agent-$AGENT_NUM (timeout: ${TIMEOUT}s)..." >&2

# Use bun to connect to broker and wait for completion
RESULT=$(timeout "$TIMEOUT" bun -e "
let done = false;
const sock = Bun.connect({
    unix: '$SOCK',
    socket: {
        open(s) {
            s.write(JSON.stringify({ type: 'wait', agent: $AGENT_NUM }) + '\n');
        },
        data(s, data) {
            done = true;
            process.stdout.write(data.toString());
            s.end();
            setTimeout(() => process.exit(0), 50);
        },
        error(s, err) {
            if (!done) { console.error('Socket error:', err.message); process.exit(1); }
        },
        close() {
            setTimeout(() => { if (!done) process.exit(1); }, 100);
        },
    },
});
" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 124 ]; then
    echo "Timeout after ${TIMEOUT}s" >&2
    exit 1
elif [ $EXIT_CODE -ne 0 ] && [ -z "$RESULT" ]; then
    echo "Error connecting to broker" >&2
    exit 1
fi

echo "$RESULT"
