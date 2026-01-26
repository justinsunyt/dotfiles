#!/bin/bash
# Tmux window/session picker with git worktree info

# Ensure PATH includes common locations
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

get_worktree_info() {
    local pane_path="$1"
    cd "$pane_path" 2>/dev/null || { echo "$pane_path"; return; }

    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
        basename "$pane_path"
        return
    fi

    # Get worktree name
    local worktree_root=$(git rev-parse --show-toplevel 2>/dev/null)
    local worktree_name=$(basename "$worktree_root")

    # Get diff stats
    local diff_stats=$(git diff --numstat 2>/dev/null | awk '{add+=$1; del+=$2} END {print add, del}')
    local staged_stats=$(git diff --cached --numstat 2>/dev/null | awk '{add+=$1; del+=$2} END {print add, del}')

    read -r unstaged_add unstaged_del <<< "$diff_stats"
    read -r staged_add staged_del <<< "$staged_stats"

    local total_add=$((${unstaged_add:-0} + ${staged_add:-0}))
    local total_del=$((${unstaged_del:-0} + ${staged_del:-0}))

    local output="$worktree_name"
    if [[ $total_add -gt 0 || $total_del -gt 0 ]]; then
        output="$output "
        [[ $total_add -gt 0 ]] && output="$output\033[32m+$total_add\033[0m"
        [[ $total_add -gt 0 && $total_del -gt 0 ]] && output="$output "
        [[ $total_del -gt 0 ]] && output="$output\033[31m-$total_del\033[0m"
    fi

    echo -e "$output"
}

# Build window list with worktree info
build_list() {
    while IFS= read -r line; do
        local target=$(echo "$line" | cut -d'|' -f1)
        local path=$(echo "$line" | cut -d'|' -f2)
        local worktree_info=$(get_worktree_info "$path")
        echo -e "$target\t$worktree_info"
    done < <(tmux list-windows -a -F '#{session_name}:#{window_index}|#{pane_current_path}' 2>/dev/null)
}

windows=$(build_list)

if [[ -z "$windows" ]]; then
    exit 0
fi

selected=$(echo -e "$windows" | fzf --tmux 80%,60% \
    --ansi \
    --prompt="Switch to: " \
    --header="Select a window" \
    --preview='tmux capture-pane -ep -t {1}' \
    --preview-window=right,60% \
    --bind='ctrl-d:preview-half-page-down' \
    --bind='ctrl-u:preview-half-page-up' \
    --delimiter='\t' \
    --with-nth=2)

if [[ -n "$selected" ]]; then
    target=$(echo "$selected" | awk '{print $1}')
    tmux switch-client -t "$target" 2>/dev/null || tmux select-window -t "$target"
fi
