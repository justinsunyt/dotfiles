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