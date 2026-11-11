# Preserve JNI entry points and callbacks invoked from libdeskfleet_desktop_viewer.so.
-keep class io.github.yet_another_ai.deskfleet.nativedesktop.DeskFleetBridge {
    public void onViewerEvent(java.lang.String);
    native <methods>;
}
-keep class io.github.yet_another_ai.deskfleet.nativedesktop.DeskFleetBridge$Companion {
    native <methods>;
}
