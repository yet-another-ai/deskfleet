//! Opt-in Android screen capture and input via upstream `scrcpy-server` (Termux / Linux).

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command};
use std::time::Duration;

use bytes::{BufMut, Bytes};
use deskfleet_capture::{CaptureError, Display};
use deskfleet_encoder::{Codec, EncoderError};
use deskfleet_input::{Backend, InputError};

use crate::media::{MediaError, Packet, pipeline::CaptureBatch};
#[cfg(target_os = "linux")]
use crate::{desktop_access::DesktopAccess, media::DesktopConfig};

#[cfg(target_os = "linux")]
const DEVICE_JAR_PATH: &str = "/data/local/tmp/deskfleet-scrcpy-server.jar";
const PACKET_FLAG_CONFIG: u64 = 1 << 63;
const PACKET_FLAG_KEY_FRAME: u64 = 1 << 62;
const PACKET_PTS_MASK: u64 = (1 << 62) - 1;
const POLL_TIMEOUT: Duration = Duration::from_millis(15);

#[cfg(target_os = "linux")]
pub(crate) fn is_configured() -> bool {
    std::env::var_os("DESKFLEET_ANDROID_SCRCPY_SERVER").is_some_and(|v| !v.is_empty())
}

fn infer_version(jar: &Path) -> String {
    if let Ok(v) = std::env::var("DESKFLEET_ANDROID_SCRCPY_VERSION")
        && !v.trim().is_empty()
    {
        return v.trim().to_owned();
    }
    jar.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.strip_suffix(".jar").unwrap_or(n))
        .and_then(|n| n.strip_prefix("scrcpy-server-v"))
        .filter(|v| !v.is_empty())
        .unwrap_or("3.1")
        .to_owned()
}

fn adb_cmd(args: &[&str]) -> Command {
    let mut cmd = Command::new("adb");
    if let Some(s) = std::env::var("DESKFLEET_ANDROID_SERIAL")
        .ok()
        .or_else(|| std::env::var("ANDROID_SERIAL").ok())
        .filter(|s| !s.trim().is_empty())
    {
        cmd.args(["-s", s.trim()]);
    }
    cmd.args(args);
    cmd
}

#[cfg(target_os = "linux")]
fn run_checked(mut cmd: Command) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("Android command failed: {e}"))?;
    if !out.status.success() {
        let (err, std) = (
            String::from_utf8_lossy(&out.stderr),
            String::from_utf8_lossy(&out.stdout),
        );
        return Err(format!(
            "Android command failed: {}{}",
            err.trim(),
            std.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(target_os = "linux")]
fn shell_cmd(script: &str) -> (Command, bool) {
    match std::env::var("DESKFLEET_ANDROID_SHELL")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some(s) if !s.is_empty() => {
            let sh = if s == "rish" { "rish -c" } else { s };
            let mut c = Command::new("sh");
            c.args(["-c", &format!("{sh} \"$1\""), "sh", script]);
            (c, true)
        }
        _ => (adb_cmd(&["shell", script]), false),
    }
}

#[cfg(target_os = "linux")]
fn prepare_server() -> Result<String, String> {
    let path = std::path::PathBuf::from(
        std::env::var_os("DESKFLEET_ANDROID_SCRCPY_SERVER")
            .filter(|v| !v.is_empty())
            .ok_or("DESKFLEET_ANDROID_SCRCPY_SERVER is not set")?,
    );
    if !path.is_file() {
        return Err(format!("scrcpy-server JAR not found at {}", path.display()));
    }
    let stage = format!("cat > {DEVICE_JAR_PATH} && chmod 644 {DEVICE_JAR_PATH}");
    let (mut cmd, is_custom) = shell_cmd(&stage);
    if is_custom {
        cmd.stdin(std::fs::File::open(&path).map_err(|e| e.to_string())?);
        run_checked(cmd)?;
    } else {
        run_checked(adb_cmd(&["push", &path.to_string_lossy(), DEVICE_JAR_PATH]))?;
    }
    Ok(infer_version(&path))
}

pub(crate) enum Socket {
    Tcp(TcpStream),
    #[cfg(target_os = "linux")]
    Unix(std::os::unix::net::UnixStream),
}

impl Socket {
    fn set_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
        match self {
            Self::Tcp(s) => s.set_read_timeout(dur),
            #[cfg(target_os = "linux")]
            Self::Unix(s) => s.set_read_timeout(dur),
        }
    }
    fn read_some(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Tcp(s) => s.read(buf),
            #[cfg(target_os = "linux")]
            Self::Unix(s) => s.read(buf),
        }
    }
    fn read_all(&mut self, buf: &mut [u8]) -> io::Result<()> {
        match self {
            Self::Tcp(s) => s.read_exact(buf),
            #[cfg(target_os = "linux")]
            Self::Unix(s) => s.read_exact(buf),
        }
    }
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        match self {
            Self::Tcp(s) => Write::write_all(s, buf),
            #[cfg(target_os = "linux")]
            Self::Unix(s) => Write::write_all(s, buf),
        }
    }
}

struct ScrcpySession {
    child: Option<Child>,
    adb_port: Option<u16>,
}

impl ScrcpySession {
    #[cfg(target_os = "linux")]
    fn connect(opts: &str) -> Result<(Self, Socket), String> {
        use std::os::linux::net::SocketAddrExt;
        use std::os::unix::net::{SocketAddr, UnixStream};
        use std::process::Stdio;

        let ver = prepare_server()?;
        let scid = (rand::random::<u32>() & 0x7fff_ffff).max(1);
        let sock_name = format!("scrcpy_{scid:08x}");
        let script = format!(
            "CLASSPATH={DEVICE_JAR_PATH} exec app_process / com.genymobile.scrcpy.Server {ver} \
             scid={scid:08x} log_level=warn tunnel_forward=true send_device_meta=false \
             send_dummy_byte=true {opts}"
        );
        let (mut cmd, is_custom) = shell_cmd(&script);
        let adb_port = if is_custom {
            None
        } else {
            let p = run_checked(adb_cmd(&[
                "forward",
                "tcp:0",
                &format!("localabstract:{sock_name}"),
            ]))?;
            Some(
                p.trim()
                    .parse::<u16>()
                    .map_err(|_| "invalid adb forward port".to_owned())?,
            )
        };
        let child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to launch scrcpy-server: {e}"))?;
        let mut session = Self {
            child: Some(child),
            adb_port,
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let sock = if let Some(port) = adb_port {
                TcpStream::connect_timeout(
                    &([127, 0, 0, 1], port).into(),
                    Duration::from_millis(250),
                )
                .map(|s| {
                    let _ = s.set_nodelay(true);
                    Socket::Tcp(s)
                })
            } else {
                let addr = SocketAddr::from_abstract_name(sock_name.as_bytes())
                    .map_err(|e| e.to_string())?;
                UnixStream::connect_addr(&addr).map(Socket::Unix)
            };
            if let Ok(mut s) = sock {
                let _ = s.set_timeout(Some(Duration::from_millis(200)));
                let mut dummy = [0u8; 1];
                if s.read_all(&mut dummy).is_ok() && dummy == [0] {
                    return Ok((session, s));
                }
            }
            if let Some(c) = session.child.as_mut()
                && let Ok(Some(st)) = c.try_wait()
            {
                let mut err = String::new();
                if let Some(mut se) = c.stderr.take() {
                    let _ = se.read_to_string(&mut err);
                }
                return Err(format!("scrcpy-server exited ({st}): {}", err.trim()));
            }
            if std::time::Instant::now() >= deadline {
                return Err("timed out connecting to scrcpy-server".to_owned());
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}

impl Drop for ScrcpySession {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(port) = self.adb_port.take() {
            let _ = adb_cmd(&["forward", "--remove", &format!("tcp:{port}")]).output();
        }
    }
}

fn after_num<T: std::str::FromStr>(s: &str, key: &str) -> Option<T> {
    s.split_once(key)?
        .1
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .parse()
        .ok()
}

fn parse_display_info(text: &str) -> Option<Display> {
    let (mut size, mut rotated, mut fps) = (None, false, 60.0_f64);
    for line in text.lines().map(str::trim) {
        for p in ["Override size:", "Physical size:"] {
            if let Some((w, h)) = line.strip_prefix(p).and_then(|r| r.trim().split_once('x'))
                && (p.starts_with("Override") || size.is_none())
                && let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>())
                && (w > 0 && h > 0)
            {
                size = Some((w, h));
            }
        }
        if line.contains("DisplayViewport{type=INTERNAL, valid=true")
            && let (Some(w), Some(h)) = (
                after_num(line, "deviceWidth="),
                after_num(line, "deviceHeight="),
            )
            && (w > 0 && h > 0)
        {
            (size, rotated) = (Some((w, h)), false);
        } else if line.contains("mOverrideDisplayInfo")
            && ["rotation 1", "rotation 3", "ROTATION_90", "ROTATION_270"]
                .iter()
                .any(|k| line.contains(k))
        {
            rotated = true;
        }
        for key in ["renderFrameRate ", "fps="] {
            if let Some(r) = after_num::<f64>(line, key).filter(|r| (1.0..=240.0).contains(r)) {
                fps = r;
            }
        }
    }
    let (mut width, mut height) = size?;
    if rotated && width < height {
        std::mem::swap(&mut width, &mut height);
    }
    Some(Display {
        id: 0,
        width,
        height,
        refresh_rate_hz: fps,
    })
}

fn parse_encoder_list(text: &str) -> Vec<String> {
    let mut found = [false; 3];
    for lower in text.lines().map(str::to_ascii_lowercase) {
        let (Some((_, c_rest)), Some((_, e_rest))) = (
            lower.split_once("--video-codec="),
            lower.split_once("--video-encoder="),
        ) else {
            continue;
        };
        let codec = c_rest.split_whitespace().next().unwrap_or_default();
        let enc = e_rest
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(['\'', '"']);
        if lower.contains("(sw)")
            || ["omx.google.", "c2.android."]
                .iter()
                .any(|p| enc.starts_with(p))
            || [".sw.", "ffmpeg"].iter().any(|p| enc.contains(p))
        {
            continue;
        }
        match codec {
            "av1" => found[0] = true,
            "h265" => found[1] = true,
            "h264" => found[2] = true,
            _ => {}
        }
    }
    ["av1", "h265", "h264"]
        .into_iter()
        .zip(found)
        .filter(|&(_, ok)| ok)
        .map(|(n, _)| n.to_owned())
        .collect()
}

#[cfg(target_os = "linux")]
pub(crate) fn displays_sync() -> Result<Vec<Display>, CaptureError> {
    let out =
        run_checked(shell_cmd("wm size; dumpsys display").0).map_err(CaptureError::Platform)?;
    parse_display_info(&out)
        .map(|d| vec![d])
        .ok_or_else(|| CaptureError::Platform("could not parse Android display size".to_owned()))
}

#[cfg(target_os = "linux")]
pub(crate) fn supported_video_codecs_sync(display_id: u32) -> Result<Vec<String>, MediaError> {
    if display_id != 0 {
        return Err(MediaError::DisplayNotFound(display_id));
    }
    let ver = prepare_server().map_err(CaptureError::Platform)?;
    let cmd = format!(
        "CLASSPATH={DEVICE_JAR_PATH} app_process / com.genymobile.scrcpy.Server {ver} \
         log_level=info list_encoders=true cleanup=false"
    );
    Ok(parse_encoder_list(
        &run_checked(shell_cmd(&cmd).0).map_err(CaptureError::Platform)?,
    ))
}

#[cfg(target_os = "linux")]
pub(crate) async fn check_access() -> Result<DesktopAccess, String> {
    tokio::task::spawn_blocking(|| {
        displays_sync().map_err(|e| e.to_string())?;
        Ok(DesktopAccess {
            screen_capture: true,
            control: true,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "linux")]
pub(crate) async fn supported() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        Ok(displays_sync().is_ok() && supported_video_codecs_sync(0).is_ok_and(|c| !c.is_empty()))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) struct ScrcpyCapture {
    _session: Option<ScrcpySession>,
    socket: Socket,
    frame_duration: Duration,
    config_csd: Vec<u8>,
    resume_keyframe: bool,
    has_video: bool,
}

impl ScrcpyCapture {
    #[cfg(target_os = "linux")]
    pub(crate) fn open(
        config: DesktopConfig,
        codec: Codec,
        audio: bool,
    ) -> Result<Self, MediaError> {
        if audio {
            return Err(MediaError::InvalidConfig(
                "Android system audio is unavailable",
            ));
        }
        config.validate()?;
        let disp = displays_sync()?
            .into_iter()
            .find(|d| d.id == config.display_id)
            .ok_or(MediaError::DisplayNotFound(config.display_id))?;
        let fps = config.fps.min(disp.refresh_rate_hz).clamp(1.0, 240.0);
        let max_size = config
            .max_width
            .map(|_| {
                let (w, h) = config.output_dimensions(disp.width, disp.height);
                format!(" max_size={}", w.max(h))
            })
            .unwrap_or_default();
        let opts = format!(
            "video=true audio=false control=false cleanup=false send_codec_meta=true \
             send_frame_meta=true video_codec={} video_bit_rate={} max_fps={} \
             video_codec_options=i-frame-interval=1{max_size}",
            codec.as_str(),
            config.bitrate_bps,
            fps.round() as u32
        );
        let (session, socket) = ScrcpySession::connect(&opts)
            .map_err(|e| MediaError::VideoEncoder(EncoderError::Platform(e)))?;
        Self::from_socket(
            Some(session),
            socket,
            codec,
            Duration::from_secs_f64(1.0 / fps),
        )
    }

    fn from_socket(
        session: Option<ScrcpySession>,
        mut socket: Socket,
        codec: Codec,
        frame_duration: Duration,
    ) -> Result<Self, MediaError> {
        socket
            .set_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| CaptureError::Platform(e.to_string()))?;
        let mut meta = [0u8; 12];
        socket
            .read_all(&mut meta)
            .map_err(|e| MediaError::VideoEncoder(EncoderError::Platform(e.to_string())))?;
        let expected = match codec {
            Codec::H264 => 0x6832_3634,
            Codec::H265 => 0x6832_3635,
            Codec::AV1 => 0x0061_7631,
        };
        let [id, w, h] = [0, 4, 8].map(|i| u32::from_be_bytes(meta[i..i + 4].try_into().unwrap()));
        if id != expected || w == 0 || h == 0 {
            return Err(MediaError::VideoEncoder(EncoderError::Platform(
                "invalid scrcpy codec header".into(),
            )));
        }
        socket
            .set_timeout(Some(POLL_TIMEOUT))
            .map_err(|e| CaptureError::Platform(e.to_string()))?;
        Ok(Self {
            _session: session,
            socket,
            frame_duration,
            config_csd: Vec::new(),
            resume_keyframe: true,
            has_video: false,
        })
    }

    pub(crate) fn poll(
        &mut self,
        _keyframe: bool,
        video_paused: bool,
    ) -> Result<CaptureBatch, MediaError> {
        let mut packets = Vec::new();
        for _ in 0..8 {
            let Some((pts_flags, mut data)) = self.read_frame()? else {
                break;
            };
            if pts_flags & PACKET_FLAG_CONFIG != 0 {
                self.config_csd = data;
                continue;
            }
            if video_paused {
                self.resume_keyframe = true;
                continue;
            }
            let is_key = pts_flags & PACKET_FLAG_KEY_FRAME != 0;
            if self.resume_keyframe && !is_key {
                continue;
            }
            (self.resume_keyframe, self.has_video) = (false, true);
            if is_key && !self.config_csd.is_empty() {
                data.splice(0..0, self.config_csd.iter().copied());
            }
            let pts_ns = (pts_flags & PACKET_PTS_MASK).saturating_mul(1_000);
            packets.push(Packet::Video(
                Bytes::from(data),
                self.frame_duration,
                pts_ns,
                is_key,
            ));
            break;
        }
        Ok(CaptureBatch {
            packets,
            encoder_started: true,
        })
    }

    fn read_frame(&mut self) -> Result<Option<(u64, Vec<u8>)>, MediaError> {
        let mut hdr = [0u8; 12];
        match self.socket.read_some(&mut hdr[..1]) {
            Ok(0) => return Err(self.fail("scrcpy video stream closed")),
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                return Ok(None);
            }
            Err(e) => return Err(self.fail(&e.to_string())),
        }
        let _ = self.socket.set_timeout(Some(Duration::from_secs(2)));
        let res = (|| -> io::Result<(u64, Vec<u8>)> {
            self.socket.read_all(&mut hdr[1..])?;
            let pts_flags = u64::from_be_bytes(hdr[..8].try_into().unwrap());
            let len = u32::from_be_bytes(hdr[8..12].try_into().unwrap()) as usize;
            if len > 16 * 1024 * 1024 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "oversized scrcpy frame",
                ));
            }
            let mut buf = vec![0u8; len];
            self.socket.read_all(&mut buf)?;
            Ok((pts_flags, buf))
        })();
        let _ = self.socket.set_timeout(Some(POLL_TIMEOUT));
        res.map(Some).map_err(|e| self.fail(&e.to_string()))
    }

    fn fail(&self, msg: &str) -> MediaError {
        if self.has_video {
            CaptureError::Platform(msg.to_owned()).into()
        } else {
            MediaError::VideoEncoder(EncoderError::Platform(msg.to_owned()))
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn stop(self) -> Result<(), MediaError> {
        Ok(())
    }
}

pub(crate) struct ScrcpyInput {
    _session: Option<ScrcpySession>,
    socket: Socket,
    width: u16,
    height: u16,
    x: f64,
    y: f64,
    touch_down: bool,
    mods: i32,
}

impl ScrcpyInput {
    #[cfg(target_os = "linux")]
    pub(crate) fn open(display_id: u32) -> Result<Self, InputError> {
        let disp = displays_sync()
            .map_err(|e| InputError::Platform(e.to_string()))?
            .into_iter()
            .find(|d| d.id == display_id)
            .ok_or(InputError::Unsupported("display was not found"))?;
        let (session, socket) = ScrcpySession::connect(
            "video=false audio=false control=true cleanup=true clipboard_autosync=false",
        )
        .map_err(InputError::Platform)?;
        Ok(Self::from_socket(
            Some(session),
            socket,
            disp.width.min(u32::from(u16::MAX)) as u16,
            disp.height.min(u32::from(u16::MAX)) as u16,
        ))
    }

    fn from_socket(
        session: Option<ScrcpySession>,
        socket: Socket,
        width: u16,
        height: u16,
    ) -> Self {
        Self {
            _session: session,
            socket,
            width: width.max(2),
            height: height.max(2),
            x: 0.5,
            y: 0.5,
            touch_down: false,
            mods: 0,
        }
    }

    fn coords(&self) -> (i32, i32) {
        (
            (self.x * f64::from(self.width - 1)).round() as i32,
            (self.y * f64::from(self.height - 1)).round() as i32,
        )
    }

    fn send_touch(&mut self, action: u8, action_btn: u32, buttons: u32) -> Result<(), InputError> {
        let (px, py) = self.coords();
        let mut msg = [0u8; 32];
        let mut b = &mut msg[..];
        b.put_u8(2);
        b.put_u8(action);
        b.put_u64(0xffff_ffff_ffff_fffe);
        b.put_i32(px);
        b.put_i32(py);
        b.put_u16(self.width);
        b.put_u16(self.height);
        b.put_u16(if self.touch_down { 0xffff } else { 0 });
        b.put_u32(action_btn);
        b.put_u32(buttons);
        self.socket
            .write_all(&msg)
            .map_err(|e| InputError::Platform(e.to_string()))
    }

    fn send_keycode(
        &mut self,
        keycode: i32,
        pressed: bool,
        repeat: bool,
    ) -> Result<(), InputError> {
        let mut msg = [0u8; 14];
        let mut b = &mut msg[..];
        b.put_u8(0);
        b.put_u8(u8::from(!pressed));
        b.put_i32(keycode);
        b.put_i32(i32::from(pressed && repeat));
        b.put_i32(self.mods);
        self.socket
            .write_all(&msg)
            .map_err(|e| InputError::Platform(e.to_string()))
    }
}

impl Backend for ScrcpyInput {
    fn move_pointer(&mut self, x: f64, y: f64) -> Result<(), InputError> {
        (self.x, self.y) = (x, y);
        let (action, btns) = if self.touch_down { (2, 1) } else { (7, 0) };
        self.send_touch(action, 0, btns)
    }

    fn button(&mut self, button: u8, pressed: bool) -> Result<(), InputError> {
        match button {
            0 => {
                self.touch_down = pressed;
                self.send_touch(u8::from(!pressed), 1, u32::from(pressed))
            }
            1 => self.send_keycode(3, pressed, false),
            2 | 3 => self.send_keycode(4, pressed, false),
            4 => self.send_keycode(187, pressed, false),
            _ => Ok(()),
        }
    }

    fn wheel(&mut self, dx: f64, dy: f64) -> Result<(), InputError> {
        let fp = |px: f64| {
            ((-px / 100.0) * 2048.0)
                .round()
                .clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
        };
        let (h, v) = (fp(dx), fp(dy));
        if h == 0 && v == 0 {
            return Ok(());
        }
        let (px, py) = self.coords();
        let mut msg = [0u8; 21];
        let mut b = &mut msg[..];
        b.put_u8(3);
        b.put_i32(px);
        b.put_i32(py);
        b.put_u16(self.width);
        b.put_u16(self.height);
        b.put_i16(h);
        b.put_i16(v);
        b.put_u32(u32::from(self.touch_down));
        self.socket
            .write_all(&msg)
            .map_err(|e| InputError::Platform(e.to_string()))
    }

    fn key(&mut self, code: &str, pressed: bool, repeat: bool) -> Result<(), InputError> {
        let (kc, bit) = android_keycode(code).ok_or(InputError::UnsupportedKey)?;
        self.mods = if pressed {
            self.mods | bit
        } else {
            self.mods & !bit
        };
        self.send_keycode(kc, pressed, repeat)
    }
}

const MOD_KEYS: &[(&str, i32, i32)] = &[
    ("ShiftLeft", 59, 1),
    ("ShiftRight", 60, 1),
    ("AltLeft", 57, 2),
    ("AltRight", 58, 2),
    ("ControlLeft", 113, 0x1000),
    ("ControlRight", 114, 0x1000),
    ("MetaLeft", 117, 0x10000),
    ("MetaRight", 118, 0x10000),
];
const NAMED_KEYS: &[(&str, i32)] = &[
    ("Enter", 66),
    ("NumpadEnter", 66),
    ("Escape", 111),
    ("Backspace", 67),
    ("Tab", 61),
    ("Space", 62),
    ("Delete", 112),
    ("Insert", 124),
    ("Home", 122),
    ("End", 123),
    ("PageUp", 92),
    ("PageDown", 93),
    ("ArrowUp", 19),
    ("ArrowDown", 20),
    ("ArrowLeft", 21),
    ("ArrowRight", 22),
    ("Minus", 69),
    ("Equal", 70),
    ("BracketLeft", 71),
    ("BracketRight", 72),
    ("Backslash", 73),
    ("Semicolon", 74),
    ("Quote", 75),
    ("Backquote", 68),
    ("Comma", 55),
    ("Period", 56),
    ("Slash", 76),
    ("CapsLock", 115),
];

fn android_keycode(code: &str) -> Option<(i32, i32)> {
    if let Some(&(_, kc, bit)) = MOD_KEYS.iter().find(|&&(k, _, _)| k == code) {
        return Some((kc, bit));
    }
    if let [b @ b'A'..=b'Z'] = code.strip_prefix("Key").map_or(&[][..], str::as_bytes) {
        return Some((i32::from(b - b'A') + 29, 0));
    }
    for (p, base) in [("Digit", 7), ("Numpad", 144)] {
        if let [b @ b'0'..=b'9'] = code.strip_prefix(p).map_or(&[][..], str::as_bytes) {
            return Some((i32::from(b - b'0') + base, 0));
        }
    }
    if let Some(n) = code
        .strip_prefix('F')
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|n| (1..=12).contains(n))
    {
        return Some((n + 130, 0));
    }
    NAMED_KEYS
        .iter()
        .find(|&&(k, _)| k == code)
        .map(|&(_, kc)| (kc, 0))
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use deskfleet_input::{InputEvent, InputSession};

    use super::*;

    #[test]
    fn parses_display_and_hardware_encoders() {
        assert_eq!(
            infer_version(Path::new("/opt/scrcpy-server-v3.2.jar")),
            "3.2"
        );
        let disp = parse_display_info(
            "Physical size: 1080x2400\nmOverrideDisplayInfo=DisplayInfo{\"Built-in\", rotation 1, fps=120.0}\n",
        )
        .unwrap();
        assert_eq!(
            (disp.width, disp.height, disp.refresh_rate_hz),
            (2400, 1080, 120.0)
        );
        let encoders = parse_encoder_list(
            "  --video-codec=h264 --video-encoder='c2.android.avc.encoder' (sw)\n\
               --video-codec=h264 --video-encoder='c2.qti.avc.encoder' (hw)\n\
               --video-codec=av1 --video-encoder='c2.qti.av1.encoder' (hw)\n",
        );
        assert_eq!(encoders, vec!["av1", "h264"]);
    }

    #[test]
    fn capture_prepends_config_csd_onto_keyframes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let writer = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.write_all(&0x6832_3634u32.to_be_bytes()).unwrap();
            s.write_all(&1080u32.to_be_bytes()).unwrap();
            s.write_all(&2400u32.to_be_bytes()).unwrap();
            for (flags, data) in [
                (PACKET_FLAG_CONFIG, &[0, 0, 0, 1, 0x67][..]),
                (PACKET_FLAG_KEY_FRAME | 5_000, &[0, 0, 0, 1, 0x65][..]),
            ] {
                s.write_all(&flags.to_be_bytes()).unwrap();
                s.write_all(&(data.len() as u32).to_be_bytes()).unwrap();
                s.write_all(data).unwrap();
            }
        });
        let client = TcpStream::connect(addr).unwrap();
        let mut cap = ScrcpyCapture::from_socket(
            None,
            Socket::Tcp(client),
            Codec::H264,
            Duration::from_millis(16),
        )
        .unwrap();
        writer.join().unwrap();
        let batch = cap.poll(true, false).unwrap();
        assert_eq!(batch.packets.len(), 1);
        let Packet::Video(bytes, _, pts_ns, is_key) = &batch.packets[0] else {
            panic!()
        };
        assert!(*is_key && *pts_ns == 5_000_000);
        assert_eq!(&bytes[..], &[0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x65]);
    }

    #[test]
    fn input_encodes_packets_and_releases_held_state_on_drop() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        {
            let mut s = InputSession::with_backend(|| {
                Ok(ScrcpyInput::from_socket(
                    None,
                    Socket::Tcp(client),
                    1001,
                    2001,
                ))
            })
            .unwrap();
            s.handle(InputEvent::PointerButton {
                button: 0,
                pressed: true,
                x: 0.5,
                y: 0.25,
            })
            .unwrap();
            s.handle(InputEvent::Key {
                code: "KeyA".into(),
                pressed: true,
                repeat: false,
            })
            .unwrap();
            s.handle(InputEvent::Wheel {
                delta_x: 0.0,
                delta_y: 100.0,
            })
            .unwrap();
        }
        let mut buf = Vec::new();
        server.read_to_end(&mut buf).unwrap();
        assert_eq!(buf.len(), 145);
        assert_eq!(
            (buf[32], buf[33], buf[64], buf[69], buf[78]),
            (2, 0, 0, 29, 3)
        );
        assert_eq!((buf[99], buf[100], buf[113], buf[114]), (0, 1, 2, 1));
    }
}
