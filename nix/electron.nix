{ callPackage, path }:
let
  version =
    (builtins.fromJSON (builtins.readFile ../apps/desktop/package.json)).devDependencies.electron;
  # Keep the runtime identical to the application's Electron dependency, even
  # when the pinned nixpkgs has not packaged that release yet. Archive hashes
  # come from Electron's v45.1.0/SHASUMS256.txt; headers use the unpacked hash.
  releases = {
    "45.1.0" = {
      x86_64-linux = "9dafab2c57ce209f8f716f8f3e4fddd8ffe0820e2455bfbbfc00b0fc13e03a3b";
      headers = "09gc30rcyf0aqlwi9fy2ls15yym94j4jrgf895jnayj3pqsi651m";
    };
  };
  hashes =
    releases.${version}
      or (throw "Update nix/electron.nix with the checksums for Electron ${version}.");
  mkElectron = callPackage (path + "/pkgs/development/tools/electron/binary/generic.nix") { };
in
mkElectron version hashes
