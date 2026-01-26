#!/bin/bash
# Tmux window title script: shows git worktree name + colored diff stats

# Ensure PATH includes common locations
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

window_id="$1"

# Get the pane's current path from tmux for this specific window
pane_path=$(tmux display-message -t "$window_id" -p '#{pane_current_path}' 2>/dev/null)

if [[ -z "$pane_path" ]]; then
    echo "#W"
    exit 0
fi

cd "$pane_path" 2>/dev/null || { basename "$pane_path"; exit 0; }

# Check if we're in a git repo
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    basename "$pane_path"
    exit 0
fi

# Get worktree name (the directory name of the worktree root)
worktree_root=$(git rev-parse --show-toplevel 2>/dev/null)
worktree_name=$(basename "$worktree_root")

# Get diff stats (staged + unstaged)
diff_stats=$(git diff --numstat 2>/dev/null | awk '{add+=$1; del+=$2} END {print add, del}')
staged_stats=$(git diff --cached --numstat 2>/dev/null | awk '{add+=$1; del+=$2} END {print add, del}')

# Parse the stats
read -r unstaged_add unstaged_del <<< "$diff_stats"
read -r staged_add staged_del <<< "$staged_stats"

# Calculate totals (handle empty values)
total_add=$((${unstaged_add:-0} + ${staged_add:-0}))
total_del=$((${unstaged_del:-0} + ${staged_del:-0}))

# Build the output with tmux color codes
output="$worktree_name"

if [[ $total_add -gt 0 || $total_del -gt 0 ]]; then
    output="$output "
    [[ $total_add -gt 0 ]] && output="$output#[fg=green]+$total_add#[fg=default]"
    [[ $total_add -gt 0 && $total_del -gt 0 ]] && output="$output "
    [[ $total_del -gt 0 ]] && output="$output#[fg=red]-$total_del#[fg=default]"
fi

echo "$output"
