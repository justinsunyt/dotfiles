#!/bin/bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Application bootstrap currently supports macOS only." >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is unavailable; apply the nix-darwin configuration first." >&2
  exit 1
fi

export HOMEBREW_NO_AUTO_UPDATE=1

install_cask_if_missing() {
  local cask_name=$1
  local artifact_path=$2

  if [[ -e "$artifact_path" || -L "$artifact_path" ]]; then
    echo "Keeping existing $artifact_path"
    return
  fi

  if brew list --cask --versions "$cask_name" >/dev/null 2>&1; then
    echo "Restoring missing artifact for $cask_name..."
    brew reinstall --cask "$cask_name"
    return
  fi

  echo "Installing missing application: $cask_name"
  brew install --cask "$cask_name"
}

install_cask_if_missing chatgpt "/Applications/ChatGPT.app"
install_cask_if_missing cursor "/Applications/Cursor.app"
install_cask_if_missing ghostty "/Applications/Ghostty.app"
install_cask_if_missing iina "/Applications/IINA.app"
install_cask_if_missing lm-studio "/Applications/LM Studio.app"
install_cask_if_missing ngrok "/opt/homebrew/bin/ngrok"
install_cask_if_missing nikitabobko/tap/aerospace "/Applications/AeroSpace.app"
install_cask_if_missing orbstack "/Applications/OrbStack.app"
install_cask_if_missing raycast "/Applications/Raycast.app"
install_cask_if_missing t3-code "/Applications/T3 Code (Alpha).app"
install_cask_if_missing tailscale-app "/Applications/Tailscale.app"
install_cask_if_missing zed "/Applications/Zed.app"
