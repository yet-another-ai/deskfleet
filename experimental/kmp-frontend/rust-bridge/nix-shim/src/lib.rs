//! Minimal cross-platform POSIX `getifaddrs` + socket-address shim compatible with
//! `rtc-shared` and `deskfleet_kmp_bridge` across macOS, Linux, iOS, and Android
//! without pulling macOS-only `UTUN_OPT_IFNAME` / `SYSPROTO_CONTROL` onto iOS targets.

#![cfg(unix)]

pub mod net {
    pub mod if_ {
        #[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
        pub struct InterfaceFlags(pub libc::c_uint);

        impl InterfaceFlags {
            pub const IFF_BROADCAST: Self = Self(libc::IFF_BROADCAST as libc::c_uint);
            pub const IFF_POINTOPOINT: Self = Self(libc::IFF_POINTOPOINT as libc::c_uint);

            pub const fn contains(self, other: Self) -> bool {
                (self.0 & other.0) == other.0
            }
        }
    }
}

pub mod sys {
    pub mod socket {
        use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6};

        pub trait SockaddrLike {}

        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
        pub enum AddressFamily {
            Inet,
            Inet6,
            Packet,
            Link,
            Other(i32),
        }

        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
        pub struct SockaddrIn(SocketAddrV4);

        impl SockaddrIn {
            pub fn ip(&self) -> Ipv4Addr {
                *self.0.ip()
            }

            pub fn port(&self) -> u16 {
                self.0.port()
            }
        }

        impl From<SockaddrIn> for SocketAddrV4 {
            fn from(value: SockaddrIn) -> Self {
                value.0
            }
        }

        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
        pub struct SockaddrIn6(SocketAddrV6);

        impl SockaddrIn6 {
            pub fn ip(&self) -> Ipv6Addr {
                *self.0.ip()
            }

            pub fn port(&self) -> u16 {
                self.0.port()
            }

            pub fn flowinfo(&self) -> u32 {
                self.0.flowinfo()
            }

            pub fn scope_id(&self) -> u32 {
                self.0.scope_id()
            }
        }

        impl From<SockaddrIn6> for SocketAddrV6 {
            fn from(value: SockaddrIn6) -> Self {
                value.0
            }
        }

        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
        pub enum SockaddrInner {
            V4(SockaddrIn),
            V6(SockaddrIn6),
            Other(AddressFamily),
        }

        #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
        pub struct SockaddrStorage {
            inner: SockaddrInner,
        }

        impl SockaddrLike for SockaddrStorage {}

        impl SockaddrStorage {
            pub fn family(&self) -> Option<AddressFamily> {
                match self.inner {
                    SockaddrInner::V4(_) => Some(AddressFamily::Inet),
                    SockaddrInner::V6(_) => Some(AddressFamily::Inet6),
                    SockaddrInner::Other(af) => Some(af),
                }
            }

            pub fn as_sockaddr_in(&self) -> Option<&SockaddrIn> {
                match &self.inner {
                    SockaddrInner::V4(v4) => Some(v4),
                    _ => None,
                }
            }

            pub fn as_sockaddr_in6(&self) -> Option<&SockaddrIn6> {
                match &self.inner {
                    SockaddrInner::V6(v6) => Some(v6),
                    _ => None,
                }
            }

            /// Converts a raw `libc::sockaddr` pointer returned by `getifaddrs`.
            ///
            /// # Safety
            /// `ptr` must be either null or point to a valid `sockaddr` for its `sa_family`.
            pub(crate) unsafe fn from_raw(ptr: *const libc::sockaddr) -> Option<Self> {
                if ptr.is_null() {
                    return None;
                }
                let family = unsafe { (*ptr).sa_family as i32 };
                if family == libc::AF_INET {
                    let sin = unsafe { &*(ptr as *const libc::sockaddr_in) };
                    let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                    let port = u16::from_be(sin.sin_port);
                    Some(Self {
                        inner: SockaddrInner::V4(SockaddrIn(SocketAddrV4::new(ip, port))),
                    })
                } else if family == libc::AF_INET6 {
                    let sin6 = unsafe { &*(ptr as *const libc::sockaddr_in6) };
                    let ip = Ipv6Addr::from(sin6.sin6_addr.s6_addr);
                    let port = u16::from_be(sin6.sin6_port);
                    let flowinfo = u32::from_be(sin6.sin6_flowinfo);
                    let scope_id = sin6.sin6_scope_id;
                    Some(Self {
                        inner: SockaddrInner::V6(SockaddrIn6(SocketAddrV6::new(
                            ip, port, flowinfo, scope_id,
                        ))),
                    })
                } else {
                    #[cfg(any(target_os = "linux", target_os = "android"))]
                    if family == libc::AF_PACKET {
                        return Some(Self {
                            inner: SockaddrInner::Other(AddressFamily::Packet),
                        });
                    }
                    #[cfg(any(
                        target_os = "macos",
                        target_os = "ios",
                        target_os = "freebsd",
                        target_os = "openbsd",
                        target_os = "netbsd",
                        target_os = "dragonfly"
                    ))]
                    if family == libc::AF_LINK {
                        return Some(Self {
                            inner: SockaddrInner::Other(AddressFamily::Link),
                        });
                    }
                    Some(Self {
                        inner: SockaddrInner::Other(AddressFamily::Other(family)),
                    })
                }
            }
        }
    }
}

pub mod ifaddrs {
    use crate::net::if_::InterfaceFlags;
    use crate::sys::socket::SockaddrStorage;
    use std::ffi::CStr;
    use std::io;
    use std::ptr;

    #[derive(Clone, Debug, Eq, Hash, PartialEq)]
    pub struct InterfaceAddress {
        pub interface_name: String,
        pub flags: InterfaceFlags,
        pub address: Option<SockaddrStorage>,
        pub netmask: Option<SockaddrStorage>,
        pub broadcast: Option<SockaddrStorage>,
        pub destination: Option<SockaddrStorage>,
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    unsafe fn ifu_ptr(ifa: &libc::ifaddrs) -> *const libc::sockaddr {
        ifa.ifa_ifu
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    unsafe fn read_netmask(ifa: &libc::ifaddrs) -> Option<SockaddrStorage> {
        let src = ifa.ifa_netmask;
        if src.is_null() {
            return None;
        }
        let mut storage = std::mem::MaybeUninit::<libc::sockaddr_storage>::zeroed();
        let copy_len = (unsafe { (*src).sa_len } as usize)
            .min(std::mem::size_of::<libc::sockaddr_storage>());
        unsafe {
            ptr::copy_nonoverlapping(src as *const u8, storage.as_mut_ptr() as *mut u8, copy_len);
            let initialized = storage.assume_init();
            SockaddrStorage::from_raw(&initialized as *const libc::sockaddr_storage as *const libc::sockaddr)
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    unsafe fn read_netmask(ifa: &libc::ifaddrs) -> Option<SockaddrStorage> {
        unsafe { SockaddrStorage::from_raw(ifa.ifa_netmask) }
    }

    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    unsafe fn ifu_ptr(ifa: &libc::ifaddrs) -> *const libc::sockaddr {
        ifa.ifa_dstaddr
    }

    pub fn getifaddrs() -> io::Result<std::vec::IntoIter<InterfaceAddress>> {
        let mut head: *mut libc::ifaddrs = ptr::null_mut();
        let rc = unsafe { libc::getifaddrs(&mut head) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }

        let mut out = Vec::new();
        let mut cur = head;
        while !cur.is_null() {
            let ifa = unsafe { &*cur };
            let name = if ifa.ifa_name.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(ifa.ifa_name) }
                    .to_string_lossy()
                    .into_owned()
            };
            let flags = InterfaceFlags(ifa.ifa_flags);
            let address = unsafe { SockaddrStorage::from_raw(ifa.ifa_addr) };
            let netmask = unsafe { read_netmask(ifa) };
            let assoc = unsafe { SockaddrStorage::from_raw(ifu_ptr(ifa)) };
            let (broadcast, destination) = if flags.contains(InterfaceFlags::IFF_POINTOPOINT) {
                (None, assoc)
            } else if flags.contains(InterfaceFlags::IFF_BROADCAST) {
                (assoc, None)
            } else {
                (None, None)
            };

            out.push(InterfaceAddress {
                interface_name: name,
                flags,
                address,
                netmask,
                broadcast,
                destination,
            });
            cur = ifa.ifa_next;
        }

        if !head.is_null() {
            unsafe { libc::freeifaddrs(head) };
        }
        Ok(out.into_iter())
    }
}
