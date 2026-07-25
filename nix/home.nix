{
  config,
  pkgs,
  username,
  dotfilesDir,
  ...
}:

let
  homeDirectory = "/Users/${username}";
  mutableLink = config.lib.file.mkOutOfStoreSymlink;
  # Bun 1.3.13 crashes while loading Kumiclaude's patched Claude bundle.
  bun_1_3_14 = pkgs.bun.overrideAttrs {
    version = "1.3.14";
    src = pkgs.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip";
      hash = "sha256-2LliIYKK1vl6x6wKt+lYcjQa92MAHogD6CZ2UsJlJiA=";
    };
  };
in
{
  home = {
    inherit username homeDirectory;
    stateVersion = "26.05";

    packages = with pkgs; [
      aria2
      awscli2
      bat
      btop
      bun_1_3_14
      cloudflared
      codex
      curl
      deno
      eza
      fd
      fastfetch
      ffmpeg
      fzf
      gh
      git
      ghostty-bin.terminfo
      gnugrep
      imagemagick
      jdk17
      jq
      lazygit
      lua-language-server
      neovim
      nodejs_22
      opencode
      pi-coding-agent
      pnpm_10
      ripgrep
      rustup
      shellcheck
      starship
      stylua
      superfile
      tmux
      tree
      tree-sitter
      uv
      watch
      yq-go
      yt-dlp
      zsh-completions
    ];

    sessionPath = [
      "$HOME/.local/bin"
      "$HOME/.local/share/npm/bin"
      "$HOME/.lmstudio/bin"
      "$HOME/.opencode/bin"
    ];

    file = {
      ".terminfo".source = "${pkgs.ghostty-bin.terminfo}/share/terminfo";
      ".zshenv".source = mutableLink "${dotfilesDir}/.zshenv";
      ".gitconfig".source = mutableLink "${dotfilesDir}/.gitconfig";

      ".claude/CLAUDE.md".source = mutableLink "${dotfilesDir}/dot_claude/CLAUDE.md";
      ".claude/settings.json".source = mutableLink "${dotfilesDir}/dot_claude/settings.json";

      ".codex/AGENTS.md".source = mutableLink "${dotfilesDir}/dot_codex/AGENTS.md";
      ".codex/config.toml".source = mutableLink "${dotfilesDir}/dot_codex/config.toml";

      ".pi/agent/AGENTS.md".source = mutableLink "${dotfilesDir}/dot_pi/AGENTS.md";
      ".pi/agent/extensions".source = mutableLink "${dotfilesDir}/dot_pi/extensions";
      ".pi/agent/settings.json".source = mutableLink "${dotfilesDir}/dot_pi/settings.json";
      ".pi/agent/skills".source = mutableLink "${dotfilesDir}/dot_pi/skills";
    };
  };

  xdg = {
    enable = true;

    configFile = {
      "aerospace".source = mutableLink "${dotfilesDir}/dot_config/aerospace";
      "gh/config.yml".source = mutableLink "${dotfilesDir}/dot_config/gh/config.yml";
      "ghostty".source = mutableLink "${dotfilesDir}/dot_config/ghostty";
      "git/ignore".source = mutableLink "${dotfilesDir}/dot_config/git/ignore";
      "nvim".source = mutableLink "${dotfilesDir}/dot_config/nvim";
      "starship".source = mutableLink "${dotfilesDir}/dot_config/starship";
      "superfile".source = mutableLink "${dotfilesDir}/dot_config/superfile";
      "tmux".source = mutableLink "${dotfilesDir}/dot_config/tmux";
      "zed/settings.json".source = mutableLink "${dotfilesDir}/dot_config/zed/settings.json";
      "zsh/.zshenv".source = mutableLink "${dotfilesDir}/.zshenv";
      "zsh/.zprofile".source = mutableLink "${dotfilesDir}/dot_config/zsh/.zprofile";
      "zsh/.zshrc".source = mutableLink "${dotfilesDir}/dot_config/zsh/.zshrc";
    };
  };

  programs.home-manager.enable = true;
}
