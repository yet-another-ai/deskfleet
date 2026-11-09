{
  lib,
  stdenvNoCC,
  fetchurl,
  unzip,
  release,
}:
let
  system = stdenvNoCC.hostPlatform.system;
in
stdenvNoCC.mkDerivation {
  pname = "deskfleet";
  inherit (release) version;

  src = fetchurl (
    release.sources.${system}
      or (throw "This DeskFleet release does not include a ${system} desktop archive")
  );

  nativeBuildInputs = [ unzip ];

  # The release archive contains the Developer ID-signed and notarized app
  # bundle. Nix must not strip, patch, or re-sign any Mach-O file in it.
  # nix-darwin copies this bundle from the store into /Applications/Nix Apps.
  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/Applications"
    unzip -q "$src" -d "$out/Applications"
    test -d "$out/Applications/deskfleet.app"
    test -x "$out/Applications/deskfleet.app/Contents/MacOS/deskfleet"
    runHook postInstall
  '';

  meta = {
    description = "Manage a team's AI agents and working environments across machines";
    homepage = "https://github.com/yet-another-ai/deskfleet";
    license = lib.licenses.asl20;
    platforms = [ "aarch64-darwin" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
