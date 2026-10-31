{
  lib,
  stdenv,
  callPackage,
  nodejs_24,
  pnpm_12,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  wrapGAppsHook3,
  glib,
  gtk3,
  gst_all_1,
  pipewire,
  publicConfig ? builtins.fromJSON (builtins.readFile ./production.json),
}:
let
  native = callPackage ./native.nix { };
  electron = callPackage ./electron.nix { };
  pnpm = pnpm_12;
  mediaLibraries = [
    glib
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
  ];
  mediaPlugins = [
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad
    pipewire
  ];
in
stdenv.mkDerivation (finalAttrs: {
  pname = "deskfleet";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = lib.cleanSource ../.;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 5;
    hash = lib.trim (builtins.readFile ./pnpm-deps-hash.txt);
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
    makeWrapper
    copyDesktopItems
    wrapGAppsHook3
  ];
  buildInputs = [
    glib
    gtk3
  ];
  dontWrapGApps = true;

  env = publicConfig // {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    CSC_IDENTITY_AUTO_DISCOVERY = "false";
    VITE_SENTRY_RELEASE = "deskfleet@v${finalAttrs.version}";
  };

  buildPhase = ''
    runHook preBuild
    export LD_LIBRARY_PATH="${
      lib.makeLibraryPath [ stdenv.cc.cc ]
    }''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    cp ${native}/lib/deskfleet.node crates/node/deskfleet.node
    pnpm --filter @deskfleet/desktop build
    # electron-builder writes the configured fuses into its copied executable.
    # Copying directly from the Nix store preserves read-only permissions.
    cp -r ${electron.dist} "$TMPDIR/electron-dist"
    chmod -R u+w "$TMPDIR/electron-dist"
    pnpm --filter @deskfleet/desktop exec electron-builder --dir --linux --publish never \
      -c.electronDist="$TMPDIR/electron-dist" -c.electronVersion=${electron.version}
    runHook postBuild
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "io.github.yet_another_ai.deskfleet";
      desktopName = "DeskFleet";
      comment = finalAttrs.meta.description;
      exec = "deskfleet %U";
      icon = "deskfleet";
      categories = [ "Development" ];
      startupWMClass = "io.github.yet_another_ai.deskfleet";
    })
  ];

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib"
    cp -r apps/desktop/release/linux-unpacked "$out/lib/deskfleet"
    install -Dm644 apps/desktop/build/icon.png "$out/share/icons/hicolor/1024x1024/apps/deskfleet.png"
    runHook postInstall
  '';

  preFixup = ''
    makeWrapper "$out/lib/deskfleet/deskfleet" "$out/bin/deskfleet" \
      "''${gappsWrapperArgs[@]}" \
      --set DESKFLEET_LAUNCHER "$out/bin/deskfleet" \
      --unset APPIMAGE \
      --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath mediaLibraries}" \
      --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${lib.makeSearchPath "lib/gstreamer-1.0" mediaPlugins}"
  '';

  passthru = { inherit native electron pnpm; };
  meta = {
    description = "Manage a team's AI agents and working environments across machines";
    homepage = "https://github.com/yet-another-ai/deskfleet";
    license = lib.licenses.asl20;
    platforms = [ "x86_64-linux" ];
    mainProgram = "deskfleet";
  };
})
