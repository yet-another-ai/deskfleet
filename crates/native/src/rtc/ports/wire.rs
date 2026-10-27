//! One frame per ordered, reliable DataChannel message. Addresses are loopback
//! families, never hostnames or arbitrary IP addresses supplied by a peer.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use bytes::{BufMut, Bytes, BytesMut};

use super::{CHUNK_BYTES, error};
use crate::rtc::Result;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Target {
    family: u8,
    port: u16,
}

impl Target {
    pub(super) fn new(host: &str, port: u16) -> Result<Self> {
        let family = match host {
            "127.0.0.1" => 4,
            "::1" => 6,
            _ => return Err(error("target must be 127.0.0.1 or ::1")),
        };
        if port == 0 {
            return Err(error("target port must be nonzero"));
        }
        Ok(Self { family, port })
    }

    pub(super) fn address(self) -> SocketAddr {
        let ip = if self.family == 4 {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else {
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        };
        SocketAddr::new(ip, self.port)
    }
}

#[derive(Debug)]
pub(super) enum Frame {
    Open(u32, Target),
    Opened(u32),
    Data(u32, Bytes),
    Window(u32),
    Fin(u32),
    Reset(u32),
}

impl Frame {
    pub(super) fn id(&self) -> u32 {
        match self {
            Self::Open(id, _)
            | Self::Opened(id)
            | Self::Data(id, _)
            | Self::Window(id)
            | Self::Fin(id)
            | Self::Reset(id) => *id,
        }
    }

    pub(super) fn encode(self) -> BytesMut {
        let tag = match &self {
            Self::Open(..) => 1,
            Self::Opened(..) => 2,
            Self::Data(..) => 3,
            Self::Window(..) => 4,
            Self::Fin(..) => 5,
            Self::Reset(..) => 6,
        };
        let size = match &self {
            Self::Open(..) => 8,
            Self::Data(_, data) => 5 + data.len(),
            _ => 5,
        };
        let mut bytes = BytesMut::with_capacity(size);
        bytes.put_u8(tag);
        bytes.put_u32(self.id());
        match self {
            Self::Open(_, target) => {
                bytes.put_u8(target.family);
                bytes.put_u16(target.port);
            }
            Self::Data(_, data) => bytes.extend_from_slice(&data),
            _ => {}
        }
        bytes
    }

    pub(super) fn decode(bytes: Bytes, is_string: bool) -> Result<Self> {
        if is_string || bytes.len() < 5 || bytes.len() > CHUNK_BYTES + 5 {
            return Err(error("invalid binary frame size"));
        }
        let id = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        if id == 0 {
            return Err(error("connection ID must be nonzero"));
        }
        match (bytes[0], bytes.len()) {
            (1, 8) => {
                let port = u16::from_be_bytes([bytes[6], bytes[7]]);
                let host = match bytes[5] {
                    4 => "127.0.0.1",
                    6 => "::1",
                    _ => return Err(error("invalid loopback address family")),
                };
                Ok(Self::Open(id, Target::new(host, port)?))
            }
            (2, 5) => Ok(Self::Opened(id)),
            (3, 6..) => Ok(Self::Data(id, bytes.slice(5..))),
            (4, 5) => Ok(Self::Window(id)),
            (5, 5) => Ok(Self::Fin(id)),
            (6, 5) => Ok(Self::Reset(id)),
            _ => Err(error("invalid frame type or length")),
        }
    }
}
