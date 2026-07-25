{
  description = "Justin's macOS development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-homebrew.url = "github:zhaofengli/nix-homebrew";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      nix-darwin,
      home-manager,
      nix-homebrew,
      ...
    }:
    let
      username = "justin";
      system = "aarch64-darwin";
      dotfilesDir = "/Users/${username}/dotfiles";
    in
    {
      darwinConfigurations.default = nix-darwin.lib.darwinSystem {
        specialArgs = {
          inherit inputs username dotfilesDir;
        };

        modules = [
          {
            nixpkgs.hostPlatform = system;
          }
          ./nix/darwin.nix
          nix-homebrew.darwinModules.nix-homebrew
          ./nix/homebrew.nix
          home-manager.darwinModules.home-manager
          {
            home-manager = {
              useGlobalPkgs = true;
              useUserPackages = true;
              backupFileExtension = "hm-backup";
              extraSpecialArgs = {
                inherit username dotfilesDir;
              };
              users.${username} = import ./nix/home.nix;
            };
          }
        ];
      };

      formatter.${system} = nixpkgs.legacyPackages.${system}.nixfmt;
    };
}
