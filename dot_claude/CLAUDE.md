# Dotfiles

Source of truth: `~/dotfiles/`

## Config locations

- `~/.config/*` symlinks to `~/dotfiles/dot_config/*`
- `~/.claude/*` symlinks to `~/dotfiles/dot_claude/*`
- `~/.zshenv` symlinks to `~/dotfiles/.zshenv`
- `~/.gitconfig` symlinks to `~/dotfiles/.gitconfig`

Always edit the source in `~/dotfiles/`, not the symlinked locations.

## Git commits

- Never add Co-Authored-By or any contributor attribution for Claude
- Use conventional commits: `type(scope): short description`
