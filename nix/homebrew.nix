{ username, ... }:

{
  nix-homebrew = {
    enable = true;
    enableRosetta = false;
    user = username;
    autoMigrate = true;
    mutableTaps = true;
  };

  homebrew = {
    enable = true;

    taps = [
      "infisical/get-cli"
      "nikitabobko/tap"
      "planetscale/tap"
    ];

    brews = [
      "cocoapods"
      "infisical/get-cli/infisical"
      "mysql-client"
      "planetscale/tap/pscale"
      {
        name = "mysql";
        restart_service = "changed";
      }
    ];

    onActivation = {
      autoUpdate = false;
      upgrade = false;
      cleanup = "none";
    };
  };
}
