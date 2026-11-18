#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

static uint8_t map_authorization_status(UNAuthorizationStatus status) {
    switch (status) {
        case UNAuthorizationStatusNotDetermined:
            return 1;
        case UNAuthorizationStatusAuthorized:
        case UNAuthorizationStatusProvisional:
            return 2;
        case UNAuthorizationStatusDenied:
            return 3;
        default:
            return 2;
    }
}

uint8_t deskfleet_notification_permission_check(void) {
    @autoreleasepool {
        if ([[NSBundle mainBundle] bundleIdentifier] == nil) {
            return 0;
        }
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block uint8_t result = 0;
        [[UNUserNotificationCenter currentNotificationCenter]
            getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings * _Nonnull settings) {
                result = map_authorization_status(settings.authorizationStatus);
                dispatch_semaphore_signal(ready);
            }];
        dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
        return result;
    }
}

uint8_t deskfleet_notification_permission_request(void) {
    @autoreleasepool {
        if ([[NSBundle mainBundle] bundleIdentifier] == nil) {
            return 0;
        }
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block BOOL completed = NO;
        UNAuthorizationOptions options = UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge;
        [[UNUserNotificationCenter currentNotificationCenter]
            requestAuthorizationWithOptions:options
                          completionHandler:^(BOOL granted, NSError * _Nullable error) {
                              (void)granted;
                              (void)error;
                              completed = YES;
                              dispatch_semaphore_signal(ready);
                          }];
        dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC));
        if (!completed) {
            return 1;
        }
        return deskfleet_notification_permission_check();
    }
}
