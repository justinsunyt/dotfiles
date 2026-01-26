#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

window_id="$1"
script_dir="$(dirname "$0")"

agent_name=$("$script_dir/agent-status.sh" "$window_id")
if [[ -n "$agent_name" ]]; then
    agent_display="#[fg=#6c7086]$agent_name#[fg=default] "
else
    agent_display=""
fi

pane_path=$(tmux display-message -t "$window_id" -p '#{pane_current_path}' 2>/dev/null)
if [[ -z "$pane_path" ]]; then
    echo "${agent_display}#W"
    exit 0
fi

cd "$pane_path" 2>/dev/null || { echo "${agent_display}$(basename "$pane_path")"; exit 0; }

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    echo "${agent_display}$(basename "$pane_path")"
    exit 0
fi

worktree_root=$(git rev-parse --show-toplevel 2>/dev/null)
worktree_name=$(basename "$worktree_root")

diff_stats=$(git diff --numstat 2>/dev/null | awk '{add+=$1; del+=$2} END {print add, del}')
staged_stats=$(git diff --cached --numstat 2>/dev/null | awk '{add+=$1; del+=$2} END {print add, del}')

read -r unstaged_add unstaged_del <<< "$diff_stats"
read -r staged_add staged_del <<< "$staged_stats"

total_add=$((${unstaged_add:-0} + ${staged_add:-0}))
total_del=$((${unstaged_del:-0} + ${staged_del:-0}))

output="${agent_display}$worktree_name"

if [[ $total_add -gt 0 || $total_del -gt 0 ]]; then
    output="$output "
    [[ $total_add -gt 0 ]] && output="$output#[fg=#a6e3a1]+$total_add#[fg=default]"
    [[ $total_add -gt 0 && $total_del -gt 0 ]] && output="$output "
    [[ $total_del -gt 0 ]] && output="$output#[fg=#f38ba8]-$total_del#[fg=default]"
fi

echo "$output"
