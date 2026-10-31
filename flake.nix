{
  description = "DeskFleet desktop application";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      overlays.default = final: _: {
        deskfleet = final.callPackage ./nix/desktop.nix { };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ self.overlays.default ];
          };
        in
        {
          inherit (pkgs) deskfleet;
          default = pkgs.deskfleet;
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          desktop = self.packages.${system}.deskfleet;
        in
        {
          inherit desktop;
          desktop-smoke =
            pkgs.runCommand "deskfleet-package-smoke"
              {
                nativeBuildInputs = [ pkgs.nodejs_24 ];
              }
              ''
                node ${self}/scripts/smoke-nix.ts ${desktop}
                touch "$out"
              '';
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);
    };
}
