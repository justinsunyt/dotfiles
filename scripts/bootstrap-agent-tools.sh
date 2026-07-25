#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DOTFILES=$(cd -- "$SCRIPT_DIR/.." && pwd)
KUMICLAUDE_DIR=${KUMICLAUDE_DIR:-"$HOME/Development/kumiclaude"}
HOME_MANAGER_PROFILE="$HOME/.local/state/nix/profiles/home-manager/home-path"

export PATH="$HOME/.local/bin:/run/current-system/sw/bin:/etc/profiles/per-user/$USER/bin:$PATH"

if [[ -z "${KUMICLAUDE_BUN:-}" && -x "$HOME_MANAGER_PROFILE/bin/bun" ]]; then
  KUMICLAUDE_BUN="$HOME_MANAGER_PROFILE/bin/bun"
fi

if [[ -n "${KUMICLAUDE_BUN:-}" ]]; then
  kumiclaude_bun_dir=$(dirname "$KUMICLAUDE_BUN")
  export KUMICLAUDE_BUN
  export PATH="$kumiclaude_bun_dir:$PATH"
fi

if [[ ! -x "$HOME/.local/bin/claude" ]]; then
  echo "Installing Claude Code with Anthropic's native installer..."
  curl --proto '=https' --tlsv1.2 -fsSL https://claude.ai/install.sh | bash
fi

mkdir -p "$(dirname "$KUMICLAUDE_DIR")"

if [[ ! -d "$KUMICLAUDE_DIR/.git" ]]; then
  git clone https://github.com/f1shy-dev/kumiclaude "$KUMICLAUDE_DIR"
elif [[ -z "$(git -C "$KUMICLAUDE_DIR" status --porcelain)" ]]; then
  git -C "$KUMICLAUDE_DIR" pull --ff-only
else
  echo "Kumiclaude has local changes; skipped automatic update." >&2
fi

(
  cd "$KUMICLAUDE_DIR"
  ./setup.sh --yes
)

for extension in lsp turboread; do
  extension_dir="$DOTFILES/dot_pi/extensions/$extension"
  if [[ -f "$extension_dir/package-lock.json" ]]; then
    npm --prefix "$extension_dir" ci
  fi
done

echo
echo "Agent tools are installed. Authentication remains local to this Mac:"
echo "  gh auth login"
echo "  claude"
echo "  codex login"
echo "  kumiclaude codex login"
echo "  pscale auth login"
