{
  inputs,
  pkgs,
  username,
  ...
}:

{
  nixpkgs.config.allowUnfree = true;

  nix = {
    package = pkgs.lixPackageSets.stable.lix;
    settings = {
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      trusted-users = [
        "root"
        username
      ];
    };
    optimise.automatic = true;
    gc = {
      automatic = true;
      interval = {
        Weekday = 7;
        Hour = 3;
        Minute = 15;
      };
      options = "--delete-older-than 30d";
    };
  };

  users.users.${username} = {
    name = username;
    home = "/Users/${username}";
  };

  system = {
    primaryUser = username;
    stateVersion = 6;
    configurationRevision = inputs.self.rev or inputs.self.dirtyRev or null;
  };

  programs.zsh.enable = true;
  environment.shells = [ pkgs.zsh ];

  fonts.packages = with pkgs; [
    inter
    nerd-fonts.jetbrains-mono
  ];
}
