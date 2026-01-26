#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

window_id="$1"

check_process() {
    local pid="$1"
    local comm=$(ps -p "$pid" -o comm= 2>/dev/null)
    local args=$(ps -p "$pid" -o args= 2>/dev/null)

    case "$comm" in
        claude|claude-code) echo "Claude Code"; return 0 ;;
        aider) echo "Aider"; return 0 ;;
        goose) echo "Goose"; return 0 ;;
        amp) echo "Amp"; return 0 ;;
    esac

    if [[ "$args" == *"/codex"* ]] || [[ "$comm" == *codex* ]]; then
        echo "Codex"
        return 0
    fi

    return 1
}

find_agent() {
    local parent_pid="$1"
    local depth="${2:-0}"
    [[ $depth -gt 10 ]] && return

    local children=$(ps -eo pid,ppid= 2>/dev/null | awk -v ppid="$parent_pid" '$2 == ppid {print $1}')

    for child_pid in $children; do
        [[ -z "$child_pid" ]] && continue

        local agent=$(check_process "$child_pid")
        if [[ -n "$agent" ]]; then
            echo "$agent"
            return 0
        fi

        local result=$(find_agent "$child_pid" $((depth + 1)))
        if [[ -n "$result" ]]; then
            echo "$result"
            return 0
        fi
    done
}

pane_pids=$(tmux list-panes -t "$window_id" -F '#{pane_pid}' 2>/dev/null)

for pane_pid in $pane_pids; do
    [[ -z "$pane_pid" ]] && continue
    agent=$(find_agent "$pane_pid")
    if [[ -n "$agent" ]]; then
        echo "$agent"
        exit 0
    fi
done
