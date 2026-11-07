{
  description = "DeskFleet server and Web source builds";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    crane.url = "github:ipetkov/crane";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      crane,
      rust-overlay,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkPackages =
        {
          system,
          webConfig ? { },
        }:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
          toolchain = builtins.fromTOML (builtins.readFile ./mise.toml);
          webToolchain = pkgs.callPackage ./nix/toolchain.nix { };
          rust = pkgs.rust-bin.stable.${toolchain.tools.rust.version}.minimal;
          craneLib = (crane.mkLib pkgs).overrideToolchain rust;
          server = pkgs.callPackage ./nix/server.nix { inherit craneLib; };
          web = pkgs.callPackage ./nix/web.nix {
            inherit webConfig;
            inherit (webToolchain) nodejs pnpm;
          };
          server-image = pkgs.callPackage ./nix/server-image.nix { inherit server web; };
        in
        {
          inherit server web server-image;
        };
    in
    {
      lib = { inherit mkPackages; };
      packages = forAllSystems (
        system:
        let
          packages = mkPackages { inherit system; };
        in
        packages // { default = packages.server-image; }
      );
      checks = forAllSystems (system: {
        inherit (self.packages.${system}) server web server-image;
      });
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
