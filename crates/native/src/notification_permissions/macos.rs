#![allow(unsafe_code)] // The Objective-C bridge takes no pointers and returns a status tag.

use super::NotificationPermission;

unsafe extern "C" {
    fn deskfleet_notification_permission_check() -> u8;
    fn deskfleet_notification_permission_request() -> u8;
}

fn from_tag(tag: u8) -> NotificationPermission {
    match tag {
        1 => NotificationPermission::Default,
        2 => NotificationPermission::Granted,
        3 => NotificationPermission::Denied,
        _ => NotificationPermission::Unsupported,
    }
}

pub(super) fn check() -> NotificationPermission {
    // SAFETY: the bridge has no pointer inputs and owns its temporary Foundation objects.
    from_tag(unsafe { deskfleet_notification_permission_check() })
}

pub(super) fn request() -> NotificationPermission {
    // SAFETY: the bridge has no pointer inputs and owns its temporary Foundation objects.
    from_tag(unsafe { deskfleet_notification_permission_request() })
}
