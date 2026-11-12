# Run on Android (Termux)

You can run the standalone `linux-arm64` `deskfleet-daemon` inside [Termux](https://termux.dev/) (`proot-distro`) to turn an Android phone or tablet into a DeskFleet Machine—hosting Agents, PTY terminals, file transfers, and optional native screen streaming and remote touch/keyboard control.

## 1. Prepare Termux

1. Install **Termux** (and optionally **Termux:Boot**) from F-Droid or GitHub Releases.
2. Grant Termux **Unrestricted** battery usage in Android Settings, and on Android 14+ enable **Developer options → Disable child process restrictions** so background Agent processes are not terminated.
3. Acquire a wake lock and set up an `aarch64` Linux container:

```sh
termux-wake-lock
pkg update && pkg install proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
```

## 2. Install and enroll `deskfleet-daemon`

Inside the Ubuntu container:

1. Install TLS root certificates, then download `deskfleet-linux-arm64.tar.gz` from [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) and extract it:
   ```sh
   apt update && apt install -y ca-certificates
   tar -xzf deskfleet-linux-arm64.tar.gz
   ```
2. Start the daemon and generate an enrollment bundle for your backend and Team:
   ```sh
   ./deskfleet-daemon &
   ./deskfleet-daemon prepare-enrollment --server-url https://your-backend.example --team-id <TEAM_ID>
   ```
3. In the DeskFleet desktop, Web, or mobile client, open **Add machine → Another machine**, paste the output, and save the issued credential JSON.
4. Import the credential on the device:
   ```sh
   ./deskfleet-daemon enroll --server-url https://your-backend.example < machine-credentials.json
   ```

## 3. Enable screen streaming and control (optional)

To view and control the native Android screen from DeskFleet, point `DESKFLEET_ANDROID_SCRCPY_SERVER` to an upstream [`scrcpy-server`](https://github.com/Genymobile/scrcpy/releases) JAR (v2.4+ or v3.x) and provide a UID 2000 (`shell`) bridge:

- **Wireless Debugging (`adb`)**: Pair Wireless Debugging on the device and connect over loopback (`adb connect 127.0.0.1:<port>`).
- **Shizuku or Root (`DESKFLEET_ANDROID_SHELL`)**: Set `DESKFLEET_ANDROID_SHELL="rish -c"` (Shizuku) or `DESKFLEET_ANDROID_SHELL="su -c"` (root) so streaming stays connected on mobile data without Wi-Fi ADB.

```sh
export DESKFLEET_ANDROID_SCRCPY_SERVER=/root/scrcpy-server-v3.1
# Optional: override shell bridge, ADB serial, or protocol version
# export DESKFLEET_ANDROID_SHELL="rish -c"
./deskfleet-daemon
```

## 4. Run as a background service

To avoid starting the daemon manually after opening Termux or rebooting:

1. In Termux (outside `proot-distro`), install `runit` supervision:
   ```sh
   pkg install termux-services
   mkdir -p "$PREFIX/var/service/deskfleet"
   cat > "$PREFIX/var/service/deskfleet/run" <<'EOF'
   #!/data/data/com.termux/files/usr/bin/sh
   exec proot-distro login ubuntu -- /root/deskfleet-daemon
   EOF
   chmod +x "$PREFIX/var/service/deskfleet/run"
   sv-enable deskfleet
   ```
2. With **Termux:Boot** installed, create `~/.termux/boot/deskfleet.sh` (`chmod +x`) containing `termux-wake-lock` so Termux starts its services automatically after the device unlocks following a reboot.
