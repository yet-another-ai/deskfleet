# The combined libnsh.so owns NSH rendering and the DeskFleet viewer JNI.
-keep class com.longbridge.nsh.** { *; }
-keep class io.github.yet_another_ai.deskfleet.nativedesktop.RemoteDesktopControls {
    public void onControlsAction(java.lang.String);
}
-keep class io.github.yet_another_ai.deskfleet.nativedesktop.DeskFleetBridge {
    public void onViewerEvent(java.lang.String);
    native <methods>;
}
-keep class io.github.yet_another_ai.deskfleet.nativedesktop.DeskFleetBridge$Companion {
    native <methods>;
}
