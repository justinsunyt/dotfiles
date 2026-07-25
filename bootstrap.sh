#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROFILE=${DOTFILES_PROFILE:-default}
EXPECTED_USER=justin
EXPECTED_HOME="/Users/$EXPECTED_USER"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This bootstrap currently supports macOS only." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This flake is configured for Apple Silicon (arm64)." >&2
  exit 1
fi

if [[ "$(id -un)" != "$EXPECTED_USER" || "$HOME" != "$EXPECTED_HOME" ]]; then
  echo "This configuration expects the macOS account $EXPECTED_USER at $EXPECTED_HOME." >&2
  exit 1
fi

if [[ "$SCRIPT_DIR" != "$HOME/dotfiles" ]]; then
  echo "Clone this repository to $HOME/dotfiles before bootstrapping." >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Installing the Xcode Command Line Tools..."
  xcode-select --install

  if [[ ! -t 0 ]]; then
    echo "Finish that installation, then rerun $SCRIPT_DIR/bootstrap.sh." >&2
    exit 1
  fi

  read -r -p "Finish the installer, then press Return to continue: "

  if ! xcode-select -p >/dev/null 2>&1; then
    echo "The Xcode Command Line Tools are not available yet." >&2
    exit 1
  fi
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
sudo -H nix --extra-experimental-features "nix-command flakes" \
  run "$SCRIPT_DIR#darwin-rebuild" -- \
  switch --flake "$SCRIPT_DIR#$PROFILE"

"$SCRIPT_DIR/scripts/bootstrap-apps.sh"
"$SCRIPT_DIR/scripts/bootstrap-agent-tools.sh"
"$SCRIPT_DIR/scripts/verify-bootstrap.sh"

echo
echo "Bootstrap complete. Open a new terminal and authenticate the listed tools."
