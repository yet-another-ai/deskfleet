{
  lib,
  stdenv,
  stdenvNoCC,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  patchelf,
  python3,
  source ? ../.,
}:
let
  versions = (builtins.fromTOML (builtins.readFile (source + "/mise.toml"))).tools;
  lock = builtins.fromTOML (builtins.readFile (source + "/mise.lock"));
  platform =
    {
      x86_64-linux = "linux-x64";
      aarch64-linux = "linux-arm64";
    }
    .${stdenv.hostPlatform.system};

  lockedTool =
    name:
    lib.findFirst (
      tool: tool.version == versions.${name}
    ) (throw "The Nix ${name} toolchain requires an up-to-date mise.lock") lock.tools.${name};
  archive =
    tool:
    let
      artifact = tool."platforms.${platform}";
    in
    fetchurl {
      inherit (artifact) url;
      sha256 = lib.removePrefix "sha256:" artifact.checksum;
    };

  # patchelf 0.19.2 corrupts this non-PIE Node executable when growing its ELF
  # headers. Keep the working patcher local to Node's fixup and verify startup.
  # Related upstream issue: https://github.com/NixOS/patchelf/issues/531
  nodePatchelf = patchelf.overrideAttrs (_: {
    version = "0.15.2";
    src = fetchurl {
      url = "https://github.com/NixOS/patchelf/releases/download/0.15.2/patchelf-0.15.2.tar.bz2";
      hash = "sha256-F3RfVkFZyOIo/EEtplogSLhGxLa0Igt3y/IkFuAvLXw=";
    };
  });

  # Use the same verified build tools as mise. These binaries only execute
  # builds; neither the Node runtime nor pnpm enters the server image.
  nodejs = stdenvNoCC.mkDerivation {
    pname = "deskfleet-nodejs";
    version = versions.node;
    src = archive (lockedTool "node");
    nativeBuildInputs = [ autoPatchelfHook ];
    buildInputs = [ stdenv.cc.cc.lib ];
    dontBuild = true;
    dontConfigure = true;
    dontStrip = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -r bin lib include "$out/"
      substituteInPlace "$out/lib/node_modules/npm/bin/npm-cli.js" \
        "$out/lib/node_modules/npm/bin/npx-cli.js" \
        --replace-fail '#!/usr/bin/env node' "#!$out/bin/node"
      runHook postInstall
    '';
    preFixup = ''
      export PATH=${nodePatchelf}/bin:$PATH
    '';
    doInstallCheck = stdenv.buildPlatform.canExecute stdenv.hostPlatform;
    installCheckPhase = ''
      runHook preInstallCheck
      "$out/bin/node" --version
      "$out/bin/npm" --version
      runHook postInstallCheck
    '';
    passthru = {
      majorVersion = lib.versions.major versions.node;
      python = python3;
    };
    meta = {
      mainProgram = "node";
      license = lib.licenses.mit;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  };

  pnpm = stdenvNoCC.mkDerivation {
    pname = "deskfleet-pnpm";
    version = versions.pnpm;
    src = archive (lockedTool "pnpm");
    sourceRoot = ".";
    nativeBuildInputs = [
      autoPatchelfHook
      makeWrapper
    ];
    buildInputs = [ stdenv.cc.cc.lib ];
    dontBuild = true;
    dontConfigure = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/pnpm" "$out/bin"
      cp -r pnpm dist "$out/lib/pnpm/"
      makeWrapper "$out/lib/pnpm/pnpm" "$out/bin/pnpm" \
        --prefix PATH : ${lib.makeBinPath [ nodejs ]}
      runHook postInstall
    '';
    passthru = {
      majorVersion = lib.versions.major versions.pnpm;
      # fetchPnpmDeps also uses Node to normalize pnpm's dependency database.
      nodejs-slim = nodejs;
    };
    meta = {
      mainProgram = "pnpm";
      license = lib.licenses.mit;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  };
in
{
  inherit nodejs pnpm;
}
