# macOS development environment

This repository bootstraps an Apple Silicon Mac with Lix, nix-darwin, Home
Manager, and Homebrew.

## Fresh Mac

Install the Xcode Command Line Tools, clone this repository to
`~/dotfiles`, and run:

```bash
./bootstrap.sh
```

The first run:

1. Separates machine-local GH, ngrok, and Zed state from the public checkout.
2. Installs Lix when Nix is not already available.
3. Applies the pinned `default` nix-darwin configuration.
4. Installs only missing macOS applications without adopting existing bundles.
5. Installs Claude Code natively, updates Kumiclaude, and installs Pi extension
   dependencies.

Subsequent configuration changes are applied with:

```bash
darwin-rebuild switch --flake ~/dotfiles#default
```

## Ownership

- Nix owns command-line tools, language runtimes, shell packages, and dotfile
  links. The shell gives Nix packages priority while retaining unique commands
  installed by Homebrew, NVM, and user-local tools.
- LazyVim is linked from `dot_config/nvim`; plugins are pinned in
  `dot_config/nvim/lazy-lock.json`.
- nix-darwin owns system configuration and the Homebrew formula declaration.
- `scripts/bootstrap-apps.sh` installs missing macOS applications with Homebrew
  while leaving existing application bundles untouched.
- Anthropic's native installer owns Claude Code because Kumiclaude patches that
  installation layout.
- Credentials, login sessions, caches, histories, and editor conversations stay
  local to each machine.

Homebrew cleanup is intentionally disabled. nix-darwin activation manages
formulae only; GUI applications are handled after activation with explicit
existence checks.

## macOS preferences

`nix/macos.nix` owns the selected macOS preferences that should follow this
account between machines:

- linear mouse input with the current pointer speed
- a fast, automatically hidden Dock
- charger-only display, sleep, and network-wake behavior

The power policy is deliberately applied only while connected to a charger.
Battery energy mode, hibernation, and OS-generated scheduled wake events remain
managed by macOS.

Apply changes with `darwin-rebuild switch --flake ~/dotfiles#default`.

## Manual authentication

Authentication is intentionally not synchronized:

```bash
gh auth login
claude
codex login
kumiclaude codex login
pscale auth login
```

Transfer SSH private keys through a secure channel or create new keys. Do not
add them to this public repository.

Berkeley Mono is not installed automatically because it is a licensed font.
Install it separately before using the Ghostty and Zed font settings.
