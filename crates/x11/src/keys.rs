//! Physical evdev positions resolve through the server's XKB key names. Do not
//! inject evdev + 8 blindly: Xorg keycodes can be reassigned independently of
//! the keyboard layout. Names follow xkeyboard-config's evdev keycode names.
use x11rb::protocol::xkb::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;

use crate::{Error, Result, platform};

pub(crate) fn resolve(connection: &RustConnection, evdev: u32) -> Result<u8> {
    let name = name(evdev).ok_or(Error::UnsupportedKey)?;
    let reply = connection
        .xkb_get_names(xkb::ID::USE_CORE_KBD.into(), xkb::NameDetail::KEY_NAMES)
        .map_err(platform)?
        .reply()
        .map_err(platform)?;
    let names = reply.value_list.key_names.ok_or(Error::UnsupportedKey)?;
    resolve_name(reply.first_key, names.iter().map(|key| key.name), name)
        .ok_or(Error::UnsupportedKey)
}

fn resolve_name(first: u8, names: impl Iterator<Item = [u8; 4]>, desired: [u8; 4]) -> Option<u8> {
    let index = names
        .enumerate()
        .find_map(|(index, name)| (name == desired).then_some(index))?;
    u8::try_from(usize::from(first) + index).ok()
}

fn numbered(prefix: [u8; 2], number: u32) -> [u8; 4] {
    [
        prefix[0],
        prefix[1],
        b'0' + (number / 10) as u8,
        b'0' + (number % 10) as u8,
    ]
}

fn name(code: u32) -> Option<[u8; 4]> {
    Some(match code {
        1 => *b"ESC\0",
        2..=13 => numbered(*b"AE", code - 1),
        14 => *b"BKSP",
        15 => *b"TAB\0",
        16..=27 => numbered(*b"AD", code - 15),
        28 => *b"RTRN",
        29 => *b"LCTL",
        30..=40 => numbered(*b"AC", code - 29),
        41 => *b"TLDE",
        42 => *b"LFSH",
        43 => *b"BKSL",
        44..=53 => numbered(*b"AB", code - 43),
        54 => *b"RTSH",
        55 => *b"KPMU",
        56 => *b"LALT",
        57 => *b"SPCE",
        58 => *b"CAPS",
        59..=68 => numbered(*b"FK", code - 58),
        69 => *b"NMLK",
        70 => *b"SCLK",
        71 => *b"KP7\0",
        72 => *b"KP8\0",
        73 => *b"KP9\0",
        74 => *b"KPSU",
        75 => *b"KP4\0",
        76 => *b"KP5\0",
        77 => *b"KP6\0",
        78 => *b"KPAD",
        79 => *b"KP1\0",
        80 => *b"KP2\0",
        81 => *b"KP3\0",
        82 => *b"KP0\0",
        83 => *b"KPDL",
        86 => *b"LSGT",
        87 => *b"FK11",
        88 => *b"FK12",
        89 => *b"AB11",
        92 => *b"HENK",
        93 => *b"HKTG",
        94 => *b"MUHE",
        96 => *b"KPEN",
        97 => *b"RCTL",
        98 => *b"KPDV",
        99 => *b"PRSC",
        100 => *b"RALT",
        102 => *b"HOME",
        103 => *b"UP\0\0",
        104 => *b"PGUP",
        105 => *b"LEFT",
        106 => *b"RGHT",
        107 => *b"END\0",
        108 => *b"DOWN",
        109 => *b"PGDN",
        110 => *b"INS\0",
        111 => *b"DELE",
        113 => *b"MUTE",
        114 => *b"VOL-",
        115 => *b"VOL+",
        116 => *b"POWR",
        117 => *b"KPEQ",
        119 => *b"PAUS",
        122 => *b"HNGL",
        123 => *b"HJCV",
        124 => *b"AE13",
        125 => *b"LWIN",
        126 => *b"RWIN",
        127 => *b"COMP",
        128 => *b"STOP",
        129 => *b"AGAI",
        131 => *b"UNDO",
        133 => *b"COPY",
        135 => *b"PAST",
        136 => *b"FIND",
        137 => *b"CUT\0",
        138 => *b"HELP",
        183..=194 => numbered(*b"FK", code - 170),
        121 | 142 | 143 | 158 | 159 | 163..=166 | 173 => {
            let number = code + 8;
            [
                b'I',
                b'0' + (number / 100) as u8,
                b'0' + ((number / 10) % 10) as u8,
                b'0' + (number % 10) as u8,
            ]
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_names_preserve_keypad_sides_and_extended_keys() {
        assert_eq!(name(30), Some(*b"AC01"));
        assert_ne!(name(28), name(96));
        assert_ne!(name(29), name(97));
        assert_eq!(name(194), Some(*b"FK24"));
        assert_eq!(name(163), Some(*b"I171"));
        assert_eq!(name(0), None);
    }

    #[test]
    fn physical_name_follows_server_mapping_instead_of_assuming_offset() {
        let names = [*b"AC02", *b"AC01", *b"LCTL"];
        assert_eq!(
            resolve_name(80, names.into_iter(), name(30).unwrap()),
            Some(81)
        );
        assert_eq!(resolve_name(80, names.into_iter(), name(97).unwrap()), None);
    }
}
