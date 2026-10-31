{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  wrapGAppsHook3,
  alsa-lib,
  at-spi2-atk,
  cairo,
  cups,
  dbus,
  expat,
  gdk-pixbuf,
  glib,
  gtk3,
  gtk4,
  nss,
  nspr,
  libx11,
  libxcb,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxrandr,
  libxkbfile,
  pango,
  pciutils,
  systemd,
  libnotify,
  pipewire,
  libsecret,
  libpulseaudio,
  speechd-minimal,
  libdrm,
  libgbm,
  libxkbcommon,
  libxshmfence,
  libGL,
  vulkan-loader,
  gst_all_1,
  release,
}:
let
  runtimeLibraries = [
    alsa-lib
    at-spi2-atk
    cairo
    cups
    dbus
    expat
    gdk-pixbuf
    glib
    gtk3
    gtk4
    nss
    nspr
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxkbfile
    pango
    pciutils
    stdenv.cc.cc
    systemd
    libnotify
    pipewire
    libsecret
    libpulseaudio
    speechd-minimal
    libdrm
    libgbm
    libxkbcommon
    libxshmfence
    libGL
    vulkan-loader
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
  inherit (release) version;
  src = fetchurl release.sources.${stdenv.hostPlatform.system};

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
    copyDesktopItems
    wrapGAppsHook3
  ];
  buildInputs = runtimeLibraries;
  dontBuild = true;
  dontWrapGApps = true;
  dontStrip = true;

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
    mkdir -p "$out/lib/deskfleet"
    cp -r . "$out/lib/deskfleet/"
    install -Dm644 ${./icon.png} "$out/share/icons/hicolor/1024x1024/apps/deskfleet.png"
    # Use the loader configured to discover NixOS Vulkan drivers.
    rm "$out/lib/deskfleet/libvulkan.so.1"
    ln -s ${lib.getLib vulkan-loader}/lib/libvulkan.so.1 "$out/lib/deskfleet/libvulkan.so.1"
    runHook postInstall
  '';

  preFixup = ''
    makeWrapper "$out/lib/deskfleet/deskfleet" "$out/bin/deskfleet" \
      "''${gappsWrapperArgs[@]}" \
      --set DESKFLEET_LAUNCHER "$out/bin/deskfleet" \
      --unset APPIMAGE \
      --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath runtimeLibraries}" \
      --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${lib.makeSearchPath "lib/gstreamer-1.0" mediaPlugins}"
  '';

  meta = {
    description = "Manage a team's AI agents and working environments across machines";
    homepage = "https://github.com/yet-another-ai/deskfleet";
    license = lib.licenses.asl20;
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    mainProgram = "deskfleet";
  };
})
