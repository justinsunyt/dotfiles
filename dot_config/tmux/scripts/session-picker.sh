#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

script_dir="$(dirname "$0")"

get_worktree_info() {
    local pane_path="$1"
    cd "$pane_path" 2>/dev/null || { echo "$pane_path"; return; }

    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
        basename "$pane_path"
        return
    fi

    local worktree_root=$(git rev-parse --show-toplevel 2>/dev/null)
    local worktree_name=$(basename "$worktree_root")
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

current=$(tmux display-message -p '#{session_name}:#{window_index}')
pos=1
i=1
lines=""

while IFS= read -r session_name; do
    # Session header line
    window_count=$(tmux list-windows -t "$session_name" 2>/dev/null | wc -l | tr -d ' ')
    lines+="$session_name\t\033[1m$session_name \033[0;90m${window_count}w\033[0m"$'\n'
    [[ "$session_name" == "${current%%:*}" ]] && pos=$i
    ((i++))

    # Window lines under this session
    while IFS='|' read -r win_index pane_path; do
        target="$session_name:$win_index"
        worktree_info=$(get_worktree_info "$pane_path")
        window_id=$(tmux display-message -t "$target" -p '#{window_id}' 2>/dev/null)
        agent_name=$("$script_dir/agent-status.sh" "$window_id")

        if [[ -n "$agent_name" ]]; then
            info="    \033[90m$agent_name\033[0m $worktree_info"
        else
            info="    $worktree_info"
        fi

        lines+="$target\t$info"$'\n'
        [[ "$target" == "$current" ]] && pos=$i
        ((i++))
    done < <(tmux list-windows -t "$session_name" -F '#{window_index}|#{pane_current_path}')
done < <(tmux list-sessions -F '#{session_name}')

lines="${lines%$'\n'}"

selected=$(echo -e "$lines" | fzf --tmux 80%,60% \
    --layout=reverse \
    --ansi \
    --sync \
    --prompt="Switch to: " \
    --header="Select a session or window" \
    --preview='tmux capture-pane -ep -t {1}' \
    --preview-window=right,60% \
    --bind='ctrl-d:preview-half-page-down' \
    --bind='ctrl-u:preview-half-page-up' \
    --bind="start:pos($pos)" \
    --delimiter='\t' \
    --with-nth=2)

if [[ -n "$selected" ]]; then
    target=$(echo "$selected" | awk '{print $1}')
    tmux switch-client -t "$target" 2>/dev/null || tmux select-window -t "$target"
fi
