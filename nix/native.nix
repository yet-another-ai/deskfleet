{
  lib,
  rustPlatform,
  cmake,
  perl,
}:

rustPlatform.buildRustPackage {
  pname = "deskfleet-native";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../crates
      ../vendor
      ../apps/server
    ];
  };

  cargoLock.lockFile = ../Cargo.lock;
  cargoBuildFlags = [
    "-p"
    "deskfleet-node"
  ];
  nativeBuildInputs = [
    cmake
    perl
  ];
  # CMake builds the bundled libopus through opusic-sys, not this workspace.
  dontUseCmakeConfigure = true;
  doCheck = false;

  # Match the existing packaging profile; the addon has no standalone Rust tests.
  env = {
    CARGO_PROFILE_RELEASE_LTO = "false";
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "16";
    CARGO_PROFILE_RELEASE_DEBUG = "0";
    CARGO_PROFILE_RELEASE_STRIP = "symbols";
  };

  installPhase = ''
    runHook preInstall
    install -Dm755 target/*/release/libdeskfleet_node.so "$out/lib/deskfleet.node"
    runHook postInstall
  '';
}
