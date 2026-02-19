# Dotfiles

Source of truth: `~/dotfiles/`

## Config locations

- `~/.config/*` symlinks to `~/dotfiles/dot_config/*`
- `~/.pi/agent/*` symlinks to `~/dotfiles/dot_pi/*` (settings, extensions, skills, AGENTS.md)
- `~/.claude/*` symlinks to `~/dotfiles/dot_claude/*`
- `~/.codex/*` symlinks to `~/dotfiles/dot_codex/*`
- `~/.zshenv` symlinks to `~/dotfiles/.zshenv`
- `~/.gitconfig` symlinks to `~/dotfiles/.gitconfig`

Always edit the source in `~/dotfiles/`, not the symlinked locations.

## Git commits

- Never add Co-Authored-By or any contributor attribution for the AI
- Use conventional commits: `type(scope): short description`
