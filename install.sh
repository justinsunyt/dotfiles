#!/bin/bash

set -e

DOTFILES="$HOME/dotfiles"
BACKUP_DIR="$HOME/.config-backup/$(date +%Y%m%d-%H%M%S)"
BACKED_UP=false

backup() {
    local path="$1"
    if [[ -e "$path" && ! -L "$path" ]]; then
        mkdir -p "$BACKUP_DIR"
        cp -R "$path" "$BACKUP_DIR/"
        BACKED_UP=true
        echo "  Backed up: $path"
    fi
}

# Recursively symlink contents of src to dest
symlink_contents() {
    local src="$1"
    local dest="$2"
    local prefix="$3"

    for item in "$src"/*; do
        [[ ! -e "$item" ]] && continue
        local name=$(basename "$item")
        local target="$dest/$name"

        if [[ -d "$item" && ! -L "$item" ]]; then
            mkdir -p "$target"
            symlink_contents "$item" "$target" "$prefix/$name"
        else
            ln -sf "$item" "$target"
            echo "  ~/$prefix/$name"
        fi
    done
}

echo "Installing dotfiles..."

mkdir -p "$HOME/.config"
mkdir -p "$HOME/.claude"
mkdir -p "$HOME/.codex"

echo ""
echo "Checking for existing configs to backup..."
backup "$HOME/.zshenv"
backup "$HOME/.gitconfig"
for dir in "$DOTFILES/dot_config"/*/; do
    backup "$HOME/.config/$(basename "$dir")"
done

if [[ "$BACKED_UP" == true ]]; then
    echo "  Backups saved to: $BACKUP_DIR"
else
    echo "  No existing configs to backup"
fi
echo ""

ln -sf "$DOTFILES/.zshenv" "$HOME/.zshenv"
echo "  ~/.zshenv"

ln -sf "$DOTFILES/.gitconfig" "$HOME/.gitconfig"
echo "  ~/.gitconfig"

echo ""
echo "Claude config:"
symlink_contents "$DOTFILES/dot_claude" "$HOME/.claude" ".claude"

echo ""
echo "Codex config:"
symlink_contents "$DOTFILES/dot_codex" "$HOME/.codex" ".codex"

echo ""
echo "~/.config:"
for dir in "$DOTFILES/dot_config"/*/; do
    name=$(basename "$dir")
    target="$HOME/.config/$name"
    [[ -e "$target" || -L "$target" ]] && rm -rf "$target"
    ln -s "$dir" "$target"
    echo "  ~/.config/$name"
done

echo ""
echo "Done! Restart your shell or run: source ~/.zshenv && source ~/.config/zsh/.zshrc"
