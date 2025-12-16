#!/bin/bash

set -e

DOTFILES="$HOME/dotfiles"

echo "Installing dotfiles..."

# Create .config if it doesn't exist
mkdir -p "$HOME/.config"

# Symlink .zshenv (tells zsh where to find config)
ln -sf "$DOTFILES/.zshenv" "$HOME/.zshenv"
echo "  ~/.zshenv -> dotfiles/.zshenv"

# Symlink all configs in dot_config to ~/.config
for dir in "$DOTFILES/dot_config"/*/; do
    name=$(basename "$dir")

    # Skip .claude (local machine config)
    if [[ "$name" == ".claude" ]]; then
        continue
    fi

    target="$HOME/.config/$name"

    # Remove existing (file, dir, or symlink)
    if [[ -e "$target" || -L "$target" ]]; then
        rm -rf "$target"
    fi

    ln -s "../dotfiles/dot_config/$name" "$target"
    echo "  ~/.config/$name -> dotfiles/dot_config/$name"
done

echo ""
echo "Done! Restart your shell or run: source ~/.zshenv && source ~/.config/zsh/.zshrc"
