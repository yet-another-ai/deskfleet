{
  lib,
  craneLib,
  perl,
  pkg-config,
  source ? ../.,
}:
let
  workspace = builtins.fromTOML (builtins.readFile (source + "/Cargo.toml"));

  # Cargo resolves the workspace even when building one package. Retain its
  # manifests and target entry points without making every desktop/media source
  # file an input to the server build.
  workspaceMetadata = lib.fileset.unions (
    map (
      member:
      let
        directory = source + "/${member}";
      in
      lib.fileset.unions [
        (directory + "/Cargo.toml")
        (lib.fileset.maybeMissing (directory + "/src/lib.rs"))
        (lib.fileset.maybeMissing (directory + "/src/main.rs"))
        (lib.fileset.maybeMissing (directory + "/build.rs"))
      ]
    ) workspace.workspace.members
  );

  src = lib.fileset.toSource {
    root = source;
    fileset = lib.fileset.unions [
      (source + "/Cargo.toml")
      (source + "/Cargo.lock")
      workspaceMetadata
      (source + "/apps/server/src")
      (source + "/crates/control-store/src")
      (source + "/crates/model/src")
      (source + "/crates/protocol/src")
      # Keep the workspace's existing crates.io patch under the same lockfile.
      (source + "/vendor/portable-pty")
    ];
  };

  commonArgs = {
    pname = "deskfleet-server";
    version = workspace.workspace.package.version;
    inherit src;
    strictDeps = true;
    cargoExtraArgs = "--locked --package deskfleet-server --bin deskfleet-server";

    # WebAuthn's OpenSSL dependency is vendored by the Cargo manifest.
    nativeBuildInputs = [
      perl
      pkg-config
    ];

    # The Test workflow owns Rust tests; the image smoke test exercises this
    # release binary with PostgreSQL and the bundled Web application.
    doCheck = false;
    CARGO_PROFILE_RELEASE_LTO = "false";
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "16";
    CARGO_PROFILE_RELEASE_DEBUG = "0";
    CARGO_PROFILE_RELEASE_STRIP = "symbols";
  };

  cargoArtifacts = craneLib.buildDepsOnly commonArgs;
in
craneLib.buildPackage (
  commonArgs
  // {
    inherit cargoArtifacts;
    meta = {
      description = "DeskFleet control-plane HTTP server";
      homepage = "https://github.com/yet-another-ai/deskfleet";
      license = lib.licenses.asl20;
      mainProgram = "deskfleet-server";
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  }
)
