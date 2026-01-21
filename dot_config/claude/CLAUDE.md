# Dotfiles

Source of truth: `~/dotfiles/`

## Config locations

- `~/.config/*` are **symlinks** to `~/dotfiles/dot_config/*`
- Always edit the source: `~/dotfiles/dot_config/<app>/` (not `~/.config/`)
- Example: edit `~/dotfiles/dot_config/zsh/.zshrc`, not `~/.config/zsh/.zshrc`

## Exceptions

- `~/.zshenv` symlinks to `~/dotfiles/.zshenv` (sets ZDOTDIR and CLAUDE_CONFIG_DIR)

## Claude config

- Location: `~/.config/claude/` (set via CLAUDE_CONFIG_DIR)
- Global CLAUDE.md: `~/.config/claude/CLAUDE.md` (this file)
- Project instructions: `<project>/CLAUDE.md`
