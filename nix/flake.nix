{
  description = "DeskFleet desktop release";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # Generated alongside the release archives by package-nix-release.ts.
      release = builtins.fromJSON (builtins.readFile ./release.json);
      forAllSystems = nixpkgs.lib.genAttrs (builtins.attrNames release.sources);
      packageFor =
        pkgs:
        pkgs.callPackage (if pkgs.stdenv.hostPlatform.isDarwin then ./desktop-darwin.nix else ./desktop.nix)
          {
            inherit release;
          };
    in
    {
      overlays.default = final: _: {
        deskfleet = packageFor final;
      };

      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          deskfleet = packageFor pkgs;
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
