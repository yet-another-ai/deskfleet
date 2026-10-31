{
  description = "DeskFleet desktop release";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # Generated alongside the release archives by package-nix-release.ts.
      release = builtins.fromJSON (builtins.readFile ./release.json);
      forAllSystems = nixpkgs.lib.genAttrs (builtins.attrNames release.sources);
    in
    {
      overlays.default = final: _: {
        deskfleet = final.callPackage ./desktop.nix { inherit release; };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          deskfleet = pkgs.callPackage ./desktop.nix { inherit release; };
        in
        {
          inherit deskfleet;
          default = deskfleet;
        }
      );

      checks = forAllSystems (system: {
        desktop = self.packages.${system}.deskfleet;
      });
    };
}
