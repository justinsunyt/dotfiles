#!/bin/bash

set -euo pipefail

HOME_MANAGER_PROFILE="$HOME/.local/state/nix/profiles/home-manager/home-path"
TPM_DIR="$HOME/.tmux/plugins/tpm"

export PATH="$HOME_MANAGER_PROFILE/bin:/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:$PATH"

mkdir -p "$(dirname "$TPM_DIR")"

if [[ ! -d "$TPM_DIR/.git" ]]; then
  if [[ -e "$TPM_DIR" ]]; then
    echo "$TPM_DIR exists but is not a Git checkout." >&2
    exit 1
  fi

  git clone --depth 1 https://github.com/tmux-plugins/tpm "$TPM_DIR"
elif [[ -z "$(git -C "$TPM_DIR" status --porcelain)" ]]; then
  git -C "$TPM_DIR" pull --ff-only
else
  echo "TPM has local changes; skipped automatic update." >&2
fi

"$TPM_DIR/bin/install_plugins"
