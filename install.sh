#!/bin/bash

set -e

DOTFILES="$HOME/dotfiles"

echo "Installing dotfiles..."

# Create .config if it doesn't exist
mkdir -p "$HOME/.config"

# Symlink .zshenv (tells zsh where to find config)
ln -sf "$DOTFILES/.zshenv" "$HOME/.zshenv"
echo "  ~/.zshenv -> dotfiles/.zshenv"

# Symlink .gitconfig
ln -sf "$DOTFILES/.gitconfig" "$HOME/.gitconfig"
echo "  ~/.gitconfig -> dotfiles/.gitconfig"

# Symlink all configs in dot_config to ~/.config
for dir in "$DOTFILES/dot_config"/*/; do
    name=$(basename "$dir")

    # Claude: selectively symlink safe files (not the whole dir)
    if [[ "$name" == "claude" ]]; then
        mkdir -p "$HOME/.config/claude"
        for file in "$DOTFILES/dot_config/claude"/*; do
            fname=$(basename "$file")
            ln -sf "../dotfiles/dot_config/claude/$fname" "$HOME/.config/claude/$fname"
            echo "  ~/.config/claude/$fname -> dotfiles/dot_config/claude/$fname"
        done
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
