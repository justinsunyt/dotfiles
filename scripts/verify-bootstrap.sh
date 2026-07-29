#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DOTFILES=$(cd -- "$SCRIPT_DIR/.." && pwd)
HOME_MANAGER_PROFILE="$HOME/.local/state/nix/profiles/home-manager/home-path"

export PATH="$HOME/.local/bin:$HOME_MANAGER_PROFILE/bin:/run/current-system/sw/bin:/opt/homebrew/bin:$PATH"

required_commands=(
  nix
  darwin-rebuild
  git
  gh
  nvim
  node
  pnpm
  bun
  deno
  codex
  claude
  kumiclaude
  pscale
  mysql
)

managed_links=(
  "$HOME/.zshenv|$DOTFILES/.zshenv"
  "$HOME/.gitconfig|$DOTFILES/.gitconfig"
  "$HOME/.config/aerospace|$DOTFILES/dot_config/aerospace"
  "$HOME/.config/nvim|$DOTFILES/dot_config/nvim"
  "$HOME/.config/zed/settings.json|$DOTFILES/dot_config/zed/settings.json"
  "$HOME/.codex/config.toml|$DOTFILES/dot_codex/config.toml"
  "$HOME/.claude/settings.json|$DOTFILES/dot_claude/settings.json"
)

failures=()

for tool_name in "${required_commands[@]}"; do
  if ! command -v "$tool_name" >/dev/null 2>&1; then
    failures+=("missing command: $tool_name")
  fi
done

for mapping in "${managed_links[@]}"; do
  target_path=${mapping%%|*}
  expected_path=${mapping#*|}

  if [[ ! -e "$target_path" && ! -L "$target_path" ]]; then
    failures+=("missing managed path: $target_path")
    continue
  fi

  resolved_path=$(/bin/realpath "$target_path" 2>/dev/null || true)
  if [[ "$resolved_path" != "$expected_path" ]]; then
    failures+=("unexpected target: $target_path -> $resolved_path")
  fi
done

while IFS= read -r plugin_spec; do
  plugin_repo=${plugin_spec%%#*}
  plugin_name=${plugin_repo##*/}
  plugin_name=${plugin_name%.git}

  if [[ ! -d "$HOME/.tmux/plugins/$plugin_name" ]]; then
    failures+=("missing tmux plugin: $plugin_name")
  fi
done < <(
  sed -En "s/^[[:space:]]*set -g @plugin ['\"]([^'\"]+)['\"].*/\1/p" \
    "$DOTFILES/dot_config/tmux/tmux.conf"
)

if (( ${#failures[@]} > 0 )); then
  echo "Bootstrap verification failed:" >&2
  printf '  - %s\n' "${failures[@]}" >&2
  exit 1
fi

echo "Bootstrap verification passed."
