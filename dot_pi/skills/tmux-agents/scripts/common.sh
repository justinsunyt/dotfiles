#!/bin/bash
# Shared constants for tmux-agents scripts
AGENT_SESSION_PREFIX="[agent] "
BROKER_SOCK_DIR="/tmp/pi-agents"

# Get the full session name with prefix
agent_session_name() {
    echo "${AGENT_SESSION_PREFIX}${1}"
}

# Get tmux target-safe session name (= prefix forces exact match, avoids glob interpretation of [])
agent_session_target() {
    echo "=${AGENT_SESSION_PREFIX}${1}"
}

# Get the broker socket path for a session
broker_socket_path() {
    echo "${BROKER_SOCK_DIR}/${1}.sock"
}

# Get the broker PID file path
broker_pid_path() {
    echo "${BROKER_SOCK_DIR}/${1}.pid"
}

# Ensure socket directory exists
mkdir -p "$BROKER_SOCK_DIR" 2>/dev/null || true
