; BEDCARE Windows Installer Script (NSIS)
; Target Output: BEDCARE-SETUP.exe
; Preserves local SQLite data directory on upgrade and supports clean uninstall.

!define PRODUCT_NAME "BEDCARE"
!define PRODUCT_VERSION "1.0.0"
!define PRODUCT_PUBLISHER "BEDCARE Hospital Systems"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "..\deliverables\BEDCARE-SETUP.exe"
InstallDir "$PROGRAMFILES64\BEDCARE"
RequestExecutionLevel admin

Section "Install BEDCARE"
  SetOutPath "$INSTDIR"
  File /r "..\dist\*.*"
  File "..\package.json"

  ; Create persistent data & backup directory in ProgramData (preserved on upgrade)
  CreateDirectory "$APPDATA\BEDCARE\data"
  CreateDirectory "$APPDATA\BEDCARE\data\backups"
  CreateDirectory "$APPDATA\BEDCARE\data\keys"

  ; Desktop & Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\BEDCARE"
  CreateShortCut "$SMPROGRAMS\BEDCARE\BEDCARE.lnk" "$INSTDIR\bedcare.exe"
  CreateShortCut "$DESKTOP\BEDCARE.lnk" "$INSTDIR\bedcare.exe"
  WriteUninstaller "$INSTDIR\Uninstall-BEDCARE.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\BEDCARE.lnk"
  RMDir /r "$SMPROGRAMS\BEDCARE"
  Delete "$INSTDIR\Uninstall-BEDCARE.exe"
  RMDir /r "$INSTDIR"
  ; Note: $APPDATA\BEDCARE\data is intentionally preserved to prevent accidental clinical data loss
SectionEnd
