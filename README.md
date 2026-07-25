# macOS development environment

This repository bootstraps Justin's Apple Silicon Mac with Lix, nix-darwin,
Home Manager, Homebrew, development tools, applications, and portable
configuration.

## Fresh Mac

The configuration expects:

- an Apple Silicon Mac
- an administrator account named `justin` with home directory `/Users/justin`
- this repository checked out at `/Users/justin/dotfiles`
- an internet connection

### 1. Install Apple's command-line tools

macOS needs the Xcode Command Line Tools before it can use Git:

```bash
xcode-select --install
```

Finish the installer that opens. This is the only prerequisite outside the
repository.

### 2. Clone and bootstrap

Run this block in Terminal:

```bash
git clone https://github.com/justinsunyt/dotfiles.git "$HOME/dotfiles" &&
  "$HOME/dotfiles/bootstrap.sh"
```

The bootstrap may ask for the administrator password and confirmation from the
Lix installer. It then:

1. Separates machine-local GH, ngrok, Zed, and shell state from the public
   checkout.
2. Installs Lix when Nix is not already available.
3. Applies the pinned nix-darwin and Home Manager configuration.
4. Installs only missing macOS applications without replacing existing app
   bundles.
5. Installs Claude Code natively, updates Kumiclaude, and installs Pi extension
   dependencies.
6. Verifies the core commands and managed dotfile links.

The script is safe to rerun. Homebrew cleanup is disabled, existing application
bundles are retained, and credentials remain local.

### 3. Authenticate

Open a new terminal and sign in to the tools you use:

```bash
gh auth login
claude
codex login
kumiclaude codex login
pscale auth login
```

Authentication is intentionally not synchronized. Transfer SSH private keys
through a secure channel or create new keys; never add them to this public
repository.

Berkeley Mono is not installed automatically because it is a licensed font.
Install it separately before using the Ghostty and Zed font settings.

## Updating a Mac

Pull and reapply everything with:

```bash
git -C "$HOME/dotfiles" pull --ff-only &&
  "$HOME/dotfiles/bootstrap.sh"
```

For a local configuration change that does not need application or agent-tool
bootstrap:

```bash
sudo -H /run/current-system/sw/bin/darwin-rebuild switch \
  --flake "$HOME/dotfiles#default"
```

## Ownership

- Nix owns command-line tools, language runtimes, shell packages, and dotfile
  links. The shell gives Nix packages priority while retaining unique commands
  installed by Homebrew, NVM, and user-local tools.
- LazyVim is linked from `dot_config/nvim`; plugins are pinned in
  `dot_config/nvim/lazy-lock.json`.
- nix-darwin owns macOS preferences, system configuration, and the Homebrew
  formula declaration.
- `scripts/bootstrap-apps.sh` installs missing macOS applications with Homebrew
  while leaving existing application bundles untouched.
- Anthropic's native installer owns Claude Code because Kumiclaude patches that
  installation layout.
- Credentials, login sessions, caches, histories, and editor conversations stay
  local to each machine.

## macOS preferences

`nix/macos.nix` owns the selected macOS preferences that should follow this
account between machines:

- linear mouse input with the current pointer speed
- a fast, automatically hidden Dock
- visible file extensions plus Finder path and status bars
- disabled writing substitutions that are disruptive in code
- separate Spaces per display for AeroSpace
- charger-only display, sleep, terminal-session, Power Nap, and network-wake
  behavior

The power policy is deliberately applied only while connected to a charger.
Battery energy mode, hibernation, and OS-generated scheduled wake events remain
managed by macOS.
