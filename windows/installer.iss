; Inno Setup script for the Windows installer - build-on-linux.sh and build.ps1 compile it with
;   ISCC /DAppVersion=<version> installer.iss      -> dist\BasicDAW-<version>-Setup.exe
; Projects and instruments live in %APPDATA%\BasicDAW, so updating or uninstalling keeps them.
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{7E0C3B5A-9F2D-4C61-B1A8-5D3E2F9A4C10}
AppName=BasicDAW
AppVersion={#AppVersion}
AppPublisher=BasicDAW
DefaultDirName={autopf}\BasicDAW
DisableProgramGroupPage=yes
; Installs for the current user without admin rights; the dialog offers all users (Program Files) too.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=dist
OutputBaseFilename=BasicDAW-{#AppVersion}-Setup
SetupIconFile=basicdaw.ico
UninstallDisplayIcon={app}\BasicDAW.exe
UninstallDisplayName=BasicDAW
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; the previous version's libraries (the app folder is replaced as a whole)
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "dist\BasicDAW\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\BasicDAW"; Filename: "{app}\BasicDAW.exe"
Name: "{autodesktop}\BasicDAW"; Filename: "{app}\BasicDAW.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\BasicDAW.exe"; Description: "{cm:LaunchProgram,BasicDAW}"; Flags: nowait postinstall skipifsilent
