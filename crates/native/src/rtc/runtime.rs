//! Configure sockets at the runtime boundary, including sockets rebound by ICE.

use std::future::Future;
use std::io;
use std::net::{SocketAddr, TcpListener, UdpSocket};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use socket2::SockRef;
use webrtc::runtime::{
    AsyncInterval, AsyncTcpListener, AsyncTcpStream, AsyncUdpSocket, JoinHandle, Runtime,
    TokioRuntime,
};

// A 64 KiB DataChannel message becomes many SCTP/DTLS datagrams. Windows' 64 KiB
// socket default cannot absorb their bursts while the peer reactor is busy.
// Keep headroom beyond the 1 MiB DataChannel send budget without growing it.
const UDP_RECEIVE_BYTES: usize = 4 * 1024 * 1024;

fn configure_udp_socket(socket: &UdpSocket) -> io::Result<()> {
    let options = SockRef::from(socket);
    if options.recv_buffer_size()? < UDP_RECEIVE_BYTES
        && let Err(error) = options.set_recv_buffer_size(UDP_RECEIVE_BYTES)
    {
        // OS limits can reject the requested size. Keep the usable socket;
        // changing system-wide kernel limits is not the daemon's job.
        tracing::warn!(%error, requested_bytes = UDP_RECEIVE_BYTES, "could not enlarge WebRTC UDP receive buffer");
    }
    tracing::debug!(
        receive_bytes = options.recv_buffer_size()?,
        requested_bytes = UDP_RECEIVE_BYTES,
        "configured WebRTC UDP receive buffer"
    );
    Ok(())
}

#[derive(Debug)]
pub(super) struct BufferedRuntime(TokioRuntime);

impl Default for BufferedRuntime {
    fn default() -> Self {
        Self(TokioRuntime)
    }
}

impl Runtime for BufferedRuntime {
    fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + Send>>) -> Box<dyn JoinHandle> {
        self.0.spawn(future)
    }

    fn spawn_reactor(
        &self,
        reactor_pool_size: usize,
        future: Pin<Box<dyn Future<Output = ()> + Send>>,
    ) -> Box<dyn JoinHandle> {
        self.0.spawn_reactor(reactor_pool_size, future)
    }

    fn wrap_udp_socket(&self, socket: UdpSocket) -> io::Result<Arc<dyn AsyncUdpSocket>> {
        configure_udp_socket(&socket)?;
        self.0.wrap_udp_socket(socket)
    }

    fn wrap_tcp_listener(&self, listener: TcpListener) -> io::Result<Arc<dyn AsyncTcpListener>> {
        self.0.wrap_tcp_listener(listener)
    }

    fn connect_tcp<'a>(
        &'a self,
        remote_addr: SocketAddr,
    ) -> Pin<Box<dyn Future<Output = io::Result<Arc<dyn AsyncTcpStream>>> + Send + 'a>> {
        self.0.connect_tcp(remote_addr)
    }

    fn resolve_host<'a>(
        &'a self,
        host: &'a str,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send + 'a>> {
        self.0.resolve_host(host)
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        self.0.sleep(duration)
    }

    fn interval(&self, period: Duration) -> Box<dyn AsyncInterval> {
        self.0.interval(period)
    }

    fn block_on(&self, future: Pin<Box<dyn Future<Output = ()> + '_>>) {
        self.0.block_on(future);
    }

    fn yield_now(&self) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        self.0.yield_now()
    }

    fn name(&self) -> &'static str {
        self.0.name()
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn udp_receive_buffers_have_burst_headroom_without_shrinking_larger_buffers() {
        for (initial_size, expected) in [
            (64 * 1024, 4 * 1024 * 1024),
            (8 * 1024 * 1024, 8 * 1024 * 1024),
        ] {
            let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
            SockRef::from(&socket)
                .set_recv_buffer_size(initial_size)
                .unwrap();
            // Windows duplicated socket handles do not share option readback.
            // Inspect the same handle that will be transferred to the reactor.
            configure_udp_socket(&socket).unwrap();
            assert!(SockRef::from(&socket).recv_buffer_size().unwrap() >= expected);
        }
    }
}
