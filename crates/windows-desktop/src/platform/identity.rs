use std::io;
use std::os::windows::io::OwnedHandle;

use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{
    GetTokenInformation, RevertToSelf, TOKEN_QUERY, TOKEN_USER, TokenSessionId, TokenUser,
};
use windows::Win32::System::Pipes::ImpersonateNamedPipeClient;
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};
use windows::core::PWSTR;

use super::{denied, error, owned, raw};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub sid: String,
    pub session: u32,
}

pub(super) fn token_identity(token: HANDLE) -> io::Result<Identity> {
    let mut needed = 0;
    // SAFETY: The token handle is live; a null query asks for the required size.
    let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut needed) };
    if needed == 0 || needed > 64 * 1024 {
        return Err(io::Error::other("cannot read desktop token identity"));
    }
    let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    // SAFETY: Storage is aligned and sized for the token's required data.
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(storage.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
    }
    .map_err(error)?;
    // SAFETY: The successful query initialized a TOKEN_USER and its SID in storage.
    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let mut sid = PWSTR::null();
    // SAFETY: The SID remains alive in storage for the call.
    unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) }.map_err(error)?;
    // SAFETY: The API returned a null-terminated allocated UTF-16 string.
    let text = unsafe { sid.to_string() }.map_err(io::Error::other);
    // SAFETY: ConvertSidToStringSidW allocates with LocalAlloc.
    unsafe { LocalFree(Some(HLOCAL(sid.0.cast()))) };
    let mut session = 0u32;
    // SAFETY: The output is an aligned DWORD with the documented size.
    unsafe {
        GetTokenInformation(
            token,
            TokenSessionId,
            Some((&mut session as *mut u32).cast()),
            4,
            &mut needed,
        )
    }
    .map_err(error)?;
    Ok(Identity {
        sid: text?,
        session,
    })
}

pub(super) fn current_token(
    access: windows::Win32::Security::TOKEN_ACCESS_MASK,
) -> io::Result<OwnedHandle> {
    let mut token = HANDLE::default();
    // SAFETY: GetCurrentProcess is a valid pseudo handle and output is initialized.
    unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) }.map_err(error)?;
    Ok(owned(token))
}

pub(super) fn require_system() -> io::Result<()> {
    let token = current_token(TOKEN_QUERY)?;
    if token_identity(raw(&token))?.sid != "S-1-5-18" {
        return Err(denied("desktop service workers must run as LocalSystem"));
    }
    Ok(())
}

pub(super) fn console_identity() -> io::Result<Identity> {
    // SAFETY: This system query takes no pointers.
    let session = unsafe { WTSGetActiveConsoleSessionId() };
    if session == u32::MAX || session == 0 {
        return Err(denied("no logged-in console desktop is available"));
    }
    let mut token = HANDLE::default();
    // SAFETY: The SYSTEM service supplies valid storage for the console user's token.
    unsafe { WTSQueryUserToken(session, &mut token) }.map_err(error)?;
    token_identity(raw(&owned(token)))
}

pub(super) fn require_console(identity: &Identity) -> io::Result<()> {
    if console_identity()? != *identity {
        return Err(denied(
            "desktop access ended because the console user or session changed",
        ));
    }
    Ok(())
}

struct Revert;
impl Drop for Revert {
    fn drop(&mut self) {
        // SAFETY: This guard is created only after successful impersonation.
        if unsafe { RevertToSelf() }.is_err() {
            // Continuing privileged work while impersonating an unknown caller is unsafe.
            std::process::abort();
        }
    }
}

pub(super) fn pipe_client(pipe: HANDLE) -> io::Result<Identity> {
    impersonate(pipe, || {
        let mut token = HANDLE::default();
        // SAFETY: Current thread is impersonating the pipe client. OpenAsSelf uses
        // the service's identity to query that token without performing client work.
        unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token) }
            .map_err(error)?;
        token_identity(raw(&owned(token)))
    })
}

pub(super) fn impersonate<T>(
    pipe: HANDLE,
    operation: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    // SAFETY: The connected pipe has already read the client's handshake byte.
    unsafe { ImpersonateNamedPipeClient(pipe) }.map_err(error)?;
    let _revert = Revert;
    operation()
}
