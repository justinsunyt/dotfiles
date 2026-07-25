if (( ! $+functions[dotfiles_prefer_nix] )); then
  source "$HOME/.zshenv"
fi

# PATH
export STARSHIP_CONFIG=~/.config/starship/starship.toml

# alias
alias ga="git add ."
alias gc="git checkout"
alias gcb="git checkout -b"
alias gcm="git commit -m "
alias gf="git fetch"
alias gp="git pull"
alias gpp="git push"
alias h="history -10"
alias hg="history | grep "
alias p="pnpm"
alias z="nvim ~/.config/zsh/.zshrc"
alias zs="source ~/.config/zsh/.zshrc"
alias cc="claude --dangerously-skip-permissions"
alias kc="kumiclaude"
alias co="codex --yolo"
alias gwtl="git worktree list"
alias gwtp="git worktree prune"
alias ta="tmux attach -t"
alias tl="tmux ls"

# Starship
eval "$(starship init zsh)"

# NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

autoload -Uz compinit
compinit

# functions
function cdd { cd ~/Development/$1 }; compdef "_path_files -W ~/Development" cdd

# Create worktree: gwt branch-name [base-branch]
# - If branch exists (local or remote), checks it out
# - If branch doesn't exist, creates it off base-branch (defaults to current branch)
function gwt {
  local branch=$1
  local base_branch=$2
  local repo_root=$(git rev-parse --show-toplevel)
  local repo_name=$(basename "$repo_root")
  local parent_dir=$(dirname "$repo_root")
  local worktree_path="$parent_dir/${repo_name}-${branch//\//-}"

  # Check if branch exists locally or on remote
  if git show-ref --verify --quiet "refs/heads/$branch" || \
     git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    # Branch exists, check it out
    git worktree add "$worktree_path" "$branch" && cd "$worktree_path"
  else
    # Branch doesn't exist, create it
    local base=${base_branch:-$(git branch --show-current)}
    git worktree add -b "$branch" "$worktree_path" "$base" && cd "$worktree_path"
  fi

  # Symlink .env files from original worktree
  for env_file in "$repo_root"/.env*; do
    [[ -f "$env_file" ]] && ln -sf "$env_file" "$worktree_path/"
  done

  # Symlink .vercel folder if it exists
  [[ -d "$repo_root/.vercel" ]] && ln -sf "$repo_root/.vercel" "$worktree_path/.vercel"
}

# Delete worktree + branch: gwtd (run from inside the worktree)
function gwtd {
  local current_path=$(pwd)
  local branch=$(git branch --show-current)
  local main_worktree=$(git worktree list | head -1 | awk '{print $1}')

  cd "$main_worktree"
  git worktree remove "$current_path" && git branch -D "$branch"
}

# Version managers and application installers may prepend their own runtimes.
# Restore the declared Nix tools while keeping their unique commands available.
dotfiles_prefer_nix
