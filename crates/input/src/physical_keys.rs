//! Bidirectional physical-key tables shared by capture and injection.

macro_rules! key_mapping {
    ($native:ty; $($code:literal $(| $alias:literal)* => $value:tt,)*) => {
        pub(super) fn keycode(code: &str) -> Option<$native> {
            Some(match code {
                $($code $(| $alias)* => $value,)*
                _ => return None,
            })
        }

        pub(super) fn physical_code(native: $native) -> Option<&'static str> {
            match native {
                $($value => Some($code),)*
                _ => None,
            }
        }

        #[test]
        fn physical_codes_round_trip() {
            $(
                assert_eq!(keycode($code), Some($value));
                assert_eq!(physical_code($value), Some($code));
            )*
        }
    };
}

/// A key's native position, before the local keyboard layout or IME is applied.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum NativeKeyCode {
    /// Linux evdev code, without the XKB offset of eight.
    Evdev(u32),
    /// macOS virtual key position from `NSEvent.keyCode`.
    MacOs(u16),
    /// Windows set-1 scan code and its E0 extended-key flag.
    Windows { scan_code: u16, extended: bool },
}

impl NativeKeyCode {
    /// Convert a native position into the physical DOM code used on the wire.
    /// Codes from other operating systems have no mapping in this build.
    #[must_use]
    pub fn code(self) -> Option<&'static str> {
        match self {
            #[cfg(any(target_os = "linux", test))]
            Self::Evdev(code) => crate::linux_keys::physical_code(code),
            #[cfg(any(target_os = "macos", test))]
            Self::MacOs(code) => crate::macos_keys::physical_code(code),
            #[cfg(any(target_os = "windows", test))]
            Self::Windows {
                scan_code,
                extended,
            } => {
                if scan_code == 0x45 && !extended {
                    return Some("Pause");
                }
                crate::windows_keys::physical_code((scan_code, extended))
            }
            #[allow(unreachable_patterns)]
            _ => None,
        }
    }
}
