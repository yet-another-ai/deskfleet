# Keep the optional machine service across application updates. Its helper owns
# administrator elevation, protected installation, and stop/replace/start.
!macro customInstall
  ClearErrors
  ExecWait '"$INSTDIR\resources\windows\deskfleet-desktop-service.exe" elevate-update' $0
  ${If} ${Errors}
    Abort "Could not update the Windows desktop service. Run the installer again."
  ${EndIf}
  ${If} $0 != 0
    Abort "Windows desktop service update failed or administrator approval was cancelled. Run the installer again."
  ${EndIf}
!macroend

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
