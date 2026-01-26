#!/bin/bash

set -e

DOTFILES="$HOME/dotfiles"
BACKUP_DIR="$HOME/.config-backup/$(date +%Y%m%d-%H%M%S)"
BACKED_UP=false

# Backup a file/directory if it exists and isn't already a symlink to dotfiles
backup() {
    local path="$1"
    if [[ -e "$path" && ! -L "$path" ]]; then
        mkdir -p "$BACKUP_DIR"
        cp -R "$path" "$BACKUP_DIR/"
        BACKED_UP=true
        echo "  Backed up: $path"
    fi
}

echo "Installing dotfiles..."

# Create .config if it doesn't exist
mkdir -p "$HOME/.config"

# Backup existing configs before overwriting
echo ""
echo "Checking for existing configs to backup..."
backup "$HOME/.zshenv"
backup "$HOME/.zshrc"
backup "$HOME/.zprofile"
backup "$HOME/.bashrc"
backup "$HOME/.bash_profile"
backup "$HOME/.gitconfig"
backup "$HOME/.claude/CLAUDE.md"
backup "$HOME/.claude/settings.json"
for dir in "$DOTFILES/dot_config"/*/; do
    name=$(basename "$dir")
    backup "$HOME/.config/$name"
done

if [[ "$BACKED_UP" == true ]]; then
    echo "  Backups saved to: $BACKUP_DIR"
else
    echo "  No existing configs to backup (already symlinked or missing)"
fi
echo ""

# Symlink .zshenv (tells zsh where to find config)
ln -sf "$DOTFILES/.zshenv" "$HOME/.zshenv"
echo "  ~/.zshenv -> dotfiles/.zshenv"

# Symlink .gitconfig
ln -sf "$DOTFILES/.gitconfig" "$HOME/.gitconfig"
echo "  ~/.gitconfig -> dotfiles/.gitconfig"

# Symlink claude config to ~/.claude/
mkdir -p "$HOME/.claude"
for file in "$DOTFILES/dot_claude"/*; do
    fname=$(basename "$file")
    ln -sf "$DOTFILES/dot_claude/$fname" "$HOME/.claude/$fname"
    echo "  ~/.claude/$fname -> dotfiles/dot_claude/$fname"
done

# Symlink all configs in dot_config to ~/.config
for dir in "$DOTFILES/dot_config"/*/; do
    name=$(basename "$dir")
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
