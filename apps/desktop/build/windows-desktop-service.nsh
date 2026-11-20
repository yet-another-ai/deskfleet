# Keep application updates non-elevated and unblocked so remote desktop users
# never lose access to an unattended UAC prompt during quit-and-install. After
# the updated app launches, it silently applies signed updates through the
# on-demand DeskFleetMaintenance service (or offers an in-app update button when
# administrator approval is still needed).
!macro customUnInstall
  ${IfNot} ${isUpdated}
    ${If} ${FileExists} "$INSTDIR\resources\windows\deskfleet-desktop-service.exe"
      ClearErrors
      ExecWait '"$INSTDIR\resources\windows\deskfleet-desktop-service.exe" elevate-uninstall' $0
      ${If} ${Errors}
        Abort "Could not remove the Windows desktop service. Uninstall again."
      ${EndIf}
      ${If} $0 != 0
        Abort "Windows desktop service removal failed or administrator approval was cancelled. Uninstall again."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
