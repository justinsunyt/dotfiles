#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DOTFILES=$(cd -- "$SCRIPT_DIR/.." && pwd)

split_config_dir() {
  local name=$1
  shift

  local source_dir="$DOTFILES/dot_config/$name"
  local target_dir="$HOME/.config/$name"
  local link_target=""

  if [[ -L "$target_dir" ]]; then
    link_target=$(readlink "$target_dir")
    if [[ "${link_target%/}" == "${source_dir%/}" ]]; then
      unlink "$target_dir"
    fi
  fi

  mkdir -p "$target_dir"

  local relative_path
  for relative_path in "$@"; do
    local source_path="$source_dir/$relative_path"
    local target_path="$target_dir/$relative_path"

    [[ -e "$source_path" || -L "$source_path" ]] || continue
    mkdir -p "$(dirname "$target_path")"

    if [[ -e "$target_path" || -L "$target_path" ]]; then
      echo "Keeping existing $target_path; left $source_path in place." >&2
      continue
    fi

    mv "$source_path" "$target_path"
    echo "Moved local state out of the public checkout: $target_path"
  done
}

move_zsh_compdump_files() {
  local source_dir="$DOTFILES/dot_config/zsh"
  local target_dir="$HOME/.config/zsh"
  local source_path

  shopt -s nullglob
  for source_path in "$source_dir"/.zcompdump*; do
    local target_path
    target_path="$target_dir/$(basename "$source_path")"

    if [[ -e "$target_path" || -L "$target_path" ]]; then
      echo "Keeping existing $target_path; left $source_path in place." >&2
      continue
    fi

    mv "$source_path" "$target_path"
    echo "Moved local state out of the public checkout: $target_path"
  done
  shopt -u nullglob
}

link_portable_config() {
  local source_path=$1
  local target_path=$2

  if [[ ! -e "$target_path" && ! -L "$target_path" ]]; then
    ln -s "$source_path" "$target_path"
    return
  fi

  if [[ -L "$target_path" && "$(readlink "$target_path")" == "$source_path" ]]; then
    return
  fi

  echo "Keeping existing $target_path; Home Manager will back it up during activation." >&2
}

mkdir -p "$HOME/.config"

split_config_dir gh hosts.yml
split_config_dir ngrok ngrok.yml
split_config_dir zed conversations prompts
split_config_dir zsh .zsh_history .zsh_sessions
move_zsh_compdump_files

if [[ -L "$HOME/.gitignore" ]]; then
  link_target=$(readlink "$HOME/.gitignore")
  if [[ "$link_target" == "$DOTFILES/.gitignore" ]]; then
    unlink "$HOME/.gitignore"
  fi
fi

link_portable_config "$DOTFILES/dot_config/gh/config.yml" "$HOME/.config/gh/config.yml"
link_portable_config "$DOTFILES/dot_config/nvim" "$HOME/.config/nvim"
link_portable_config "$DOTFILES/dot_config/zed/settings.json" "$HOME/.config/zed/settings.json"
link_portable_config "$DOTFILES/dot_config/zsh/.zprofile" "$HOME/.config/zsh/.zprofile"
link_portable_config "$DOTFILES/dot_config/zsh/.zshrc" "$HOME/.config/zsh/.zshrc"

echo "Home directory is ready for Home Manager activation."
