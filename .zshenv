export XDG_CONFIG_HOME="$HOME/.config"
export ZDOTDIR="$HOME/.config/zsh"
[[ -s "$HOME/.cargo/env" ]] && . "$HOME/.cargo/env"

HM_SESSION_VARS="/etc/profiles/per-user/$USER/etc/profile.d/hm-session-vars.sh"
[[ -r "$HM_SESSION_VARS" ]] && source "$HM_SESSION_VARS"
unset HM_SESSION_VARS

dotfiles_prefer_nix() {
  typeset -gU path PATH
  path=(
    "$HOME/.local/state/nix/profiles/home-manager/home-path/bin"
    "/etc/profiles/per-user/$USER/bin"
    "/run/current-system/sw/bin"
    "$HOME/.local/bin"
    "$HOME/.local/share/npm/bin"
    "$HOME/.lmstudio/bin"
    "$HOME/.ami/bin"
    "/opt/homebrew/opt/mysql-client/bin"
    "$HOME/.opencode/bin"
    $path
  )
  export PATH
}

dotfiles_prefer_nix
