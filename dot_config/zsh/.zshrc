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
alias co="codex --yolo"
alias gwtl="git worktree list"
alias gwtp="git worktree prune"

# Starship
eval "$(starship init zsh)"

# NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# zsh-completions
if type brew &>/dev/null; then
  FPATH=$(brew --prefix)/share/zsh-completions:$FPATH
fi
autoload -Uz compinit
compinit

# functions
function cdd { cd ~/Development/$1 }; compdef "_path_files -W ~/Development" cdd

# Create worktree: gwt justin/feature-name
# From ~/Development/scout on main -> creates ~/Development/scout-justin/feature-name with branch justin/feature-name
function gwt {
  local branch=$1
  local base_branch=$(git branch --show-current)
  local repo_root=$(git rev-parse --show-toplevel)
  local repo_name=$(basename "$repo_root")
  local parent_dir=$(dirname "$repo_root")
  local worktree_path="$parent_dir/${repo_name}-${branch//\//-}"

  git worktree add -b "$branch" "$worktree_path" "$base_branch" && cd "$worktree_path"

  # Copy .env files from original worktree
  for env_file in "$repo_root"/.env*; do
    [[ -f "$env_file" ]] && cp "$env_file" "$worktree_path/"
  done
}

# Delete worktree + branch: gwtd (run from inside the worktree)
function gwtd {
  local current_path=$(pwd)
  local branch=$(git branch --show-current)
  local main_worktree=$(git worktree list | head -1 | awk '{print $1}')

  cd "$main_worktree"
  git worktree remove "$current_path" && git branch -D "$branch"
}

# bun completions
[ -s "/Users/justin/.bun/_bun" ] && source "/Users/justin/.bun/_bun"


# Added by LM Studio CLI (lms)
export PATH="$PATH:/Users/justin/.lmstudio/bin"
# End of LM Studio CLI section


# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"

# ami
export PATH="$HOME/.ami/bin:$PATH"