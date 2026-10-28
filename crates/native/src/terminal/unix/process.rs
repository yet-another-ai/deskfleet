//! Wait for an owned Unix child without polling or racing signals against PID reuse.

#![allow(unsafe_code)]

use std::io;
use std::mem::MaybeUninit;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use portable_pty::{Child, ExitStatus};
use tokio::sync::watch;

use crate::terminal::{Result, backend, lock};

pub(crate) type ExitResult = std::result::Result<ExitStatus, String>;

struct State {
    child: Option<Box<dyn Child + Send + Sync>>,
    waiter_started: bool,
    result: Option<ExitResult>,
}

pub(crate) struct Process {
    pid: Option<Pid>,
    state: Mutex<State>,
    finished: Condvar,
    status: watch::Sender<Option<ExitResult>>,
}

impl Process {
    pub(crate) fn new(child: Box<dyn Child + Send + Sync>) -> Arc<Self> {
        let pid = child
            .process_id()
            .and_then(|pid| i32::try_from(pid).ok())
            .filter(|pid| *pid > 0)
            .map(Pid::from_raw);
        let (status, _) = watch::channel(None);
        Arc::new(Self {
            pid,
            state: Mutex::new(State {
                child: Some(child),
                waiter_started: false,
                result: None,
            }),
            finished: Condvar::new(),
            status,
        })
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<Option<ExitResult>> {
        self.status.subscribe()
    }

    #[cfg(test)]
    pub(crate) fn process_id(&self) -> u32 {
        self.pid
            .expect("a spawned Unix child has a process ID")
            .as_raw()
            .unsigned_abs()
    }

    /// Start only after the caller owns the PTY handles and its rollback path.
    pub(crate) fn start_waiter(self: &Arc<Self>) -> Result<()> {
        let pid = self
            .pid
            .ok_or_else(|| backend("start process waiter", "child has no valid Unix process ID"))?;
        let mut state = lock(&self.state);
        if state.waiter_started || state.result.is_some() {
            return Ok(());
        }
        let process = Arc::clone(self);
        // Keep the child in State until the new thread actually starts. A failed
        // spawn leaves it available for terminate() after the PTY is released.
        match std::thread::Builder::new()
            .name("deskfleet-pty-wait".into())
            .spawn(move || process.wait_for_exit(pid))
        {
            Ok(_) => state.waiter_started = true,
            Err(error) => return Err(backend("start process waiter", error)),
        }
        Ok(())
    }

    fn wait_for_exit(&self, pid: Pid) {
        let mut child = lock(&self.state)
            .child
            .take()
            .expect("the process waiter takes its child exactly once");
        let observed = wait_without_reaping(pid);
        let mut state = lock(&self.state);
        let result = observed.and_then(|()| child.wait());
        let result = match result {
            Ok(status) => Ok(status),
            Err(error) => {
                // The caller can still terminate/reap the child if observing
                // its exit failed. Do not lose ownership on this error path.
                state.child = Some(child);
                state.waiter_started = false;
                Err(error.to_string())
            }
        };
        self.publish(&mut state, result);
    }

    fn publish(&self, state: &mut State, result: ExitResult) {
        state.result = Some(result.clone());
        self.status.send_replace(Some(result));
        self.finished.notify_all();
    }

    /// The caller must cancel I/O and release its PTY descriptors before waiting.
    pub(crate) fn terminate(&self, foreground_group: Option<i32>) -> Result<()> {
        let mut state = lock(&self.state);
        if state.waiter_started && state.result.is_none() {
            let pid = self
                .pid
                .ok_or_else(|| backend("terminate", "child has no valid Unix process ID"))?;
            if let Some(group) = foreground_group.filter(|group| *group > 0) {
                let _ = killpg(Pid::from_raw(group), Signal::SIGHUP);
            }
            signal(pid, Signal::SIGHUP)?;
            // WNOWAIT keeps the child waitable until this same mutex protects
            // the final reap. Signals can never target a recycled child PID.
            (state, _) = self
                .finished
                .wait_timeout_while(state, Duration::from_millis(200), |state| {
                    state.result.is_none()
                })
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.result.is_none() {
                signal(pid, Signal::SIGKILL)?;
                state = self
                    .finished
                    .wait_while(state, |state| state.result.is_none())
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
        }
        if !state.waiter_started
            && let Some(mut child) = state.child.take()
        {
            // No waiter started, or exit observation failed. The original
            // child is the sole reaper and retains SIGKILL escalation.
            let result = (|| {
                if child.try_wait()?.is_none() {
                    if let Some(group) = foreground_group.filter(|group| *group > 0) {
                        let _ = killpg(Pid::from_raw(group), Signal::SIGHUP);
                    }
                    child.kill()?;
                }
                child.wait()
            })()
            .map_err(|error: io::Error| error.to_string());
            let result = match state.result.take() {
                Some(Err(error)) if result.is_ok() => Err(error),
                _ => result,
            };
            self.publish(&mut state, result);
        }
        match state.result.as_ref() {
            Some(Ok(_)) => Ok(()),
            Some(Err(error)) => Err(backend("wait", error)),
            None => Err(backend("wait", "process waiter did not report a result")),
        }
    }
}

fn signal(pid: Pid, signal: Signal) -> Result<()> {
    match kill(pid, signal) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
        Err(error) => Err(backend("terminate", error)),
    }
}

fn wait_without_reaping(pid: Pid) -> io::Result<()> {
    let id = nix::libc::id_t::try_from(pid.as_raw())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    loop {
        let mut info = MaybeUninit::<nix::libc::siginfo_t>::uninit();
        // SAFETY: info points to writable siginfo_t storage. P_PID identifies
        // our owned child; WNOWAIT leaves reaping to Child::wait under state.
        // libc is used because nix's waitid wrapper is not exposed on macOS.
        let result = unsafe {
            nix::libc::waitid(
                nix::libc::P_PID,
                id,
                info.as_mut_ptr(),
                nix::libc::WEXITED | nix::libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
