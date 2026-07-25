#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROFILE=${DOTFILES_PROFILE:-default}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This bootstrap currently supports macOS only." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This flake is configured for Apple Silicon (arm64)." >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Installing the Xcode Command Line Tools..."
  xcode-select --install
  echo "Finish that installation, then run ./bootstrap.sh again."
  exit 0
fi

"$SCRIPT_DIR/scripts/prepare-home.sh"

NIX_DAEMON_PROFILE=/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

if [[ -e "$NIX_DAEMON_PROFILE" ]]; then
  # shellcheck disable=SC1090
  source "$NIX_DAEMON_PROFILE"
fi

if ! command -v nix >/dev/null 2>&1; then
  echo "Installing Lix..."
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.lix.systems/lix |
    sh -s -- install
fi

if [[ -e "$NIX_DAEMON_PROFILE" ]]; then
  # shellcheck disable=SC1090
  source "$NIX_DAEMON_PROFILE"
fi

if ! command -v nix >/dev/null 2>&1; then
  echo "Nix was installed but is not available in this shell. Open a new terminal and rerun bootstrap." >&2
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/flake.lock" ]]; then
  echo "flake.lock is missing. Generate and commit it before bootstrapping." >&2
  exit 1
fi

if git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
  ! git -C "$SCRIPT_DIR" ls-files --error-unmatch flake.nix >/dev/null 2>&1; then
  echo "flake.nix is untracked. Stage or commit the flake files before bootstrapping." >&2
  exit 1
fi

echo "Applying nix-darwin and Home Manager configuration..."
sudo -H nix run github:nix-darwin/nix-darwin/master#darwin-rebuild -- \
  switch --flake "$SCRIPT_DIR#$PROFILE"

"$SCRIPT_DIR/scripts/bootstrap-apps.sh"
"$SCRIPT_DIR/scripts/bootstrap-agent-tools.sh"

echo
echo "Bootstrap complete. Open a new terminal and authenticate the listed tools."
