#![allow(unsafe_code)] // The bridge owns its monitor and returns only a boolean value.

unsafe extern "C" {
    fn deskfleet_network_is_metered() -> bool;
}

pub(super) fn is_metered() -> bool {
    // SAFETY: the bridge has no pointer inputs and owns all Network.framework
    // objects until its snapshot completes or times out.
    unsafe { deskfleet_network_is_metered() }
}
