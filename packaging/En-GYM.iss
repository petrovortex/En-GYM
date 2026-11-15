#if VER < 0x06070400
  #error Use Inno Setup 6.7.4 or newer
#endif
[Setup]
AppId={{732FA5F0-5A1D-4B19-9C0E-F067968A8404}
AppName=En-GYM
AppVersion={#ProductVersion}
VersionInfoVersion={#ProductVersion}.0
AppPublisher=Alexander Petrov
AppPublisherURL=https://petrovortex.github.io/
AppSupportURL=https://petrovortex.github.io/En-GYM/
DefaultDirName={localappdata}\Programs\En-GYM
DefaultGroupName=En-GYM
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
Compression=lzma2/normal
SolidCompression=no
WizardStyle=modern
SetupIconFile={#LogoFile}
UninstallDisplayIcon={app}\En-GYM.exe
OutputDir={#OutputFolder}
OutputBaseFilename=En-GYM-Setup
CloseApplications=yes
RestartApplications=no
Uninstallable=not FixtureInstall
CreateUninstallRegKey=not FixtureInstall

[Files]
Source: "{#Payload}\runtime\node.exe"; DestDir: "{tmp}\bootstrap\runtime"; Flags: dontcopy
Source: "{#Bootstrap}\*"; DestDir: "{tmp}\bootstrap"; Flags: dontcopy recursesubdirs
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Check: not FixtureInstall

[Icons]
Name: "{userprograms}\En-GYM"; Filename: "{app}\En-GYM.exe"; Check: not FixtureInstall
Name: "{userdesktop}\En-GYM"; Filename: "{app}\En-GYM.exe"; Tasks: desktopicon; Check: not FixtureInstall

[Run]
Filename: "{app}\En-GYM.exe"; Description: "Open En-GYM"; Flags: postinstall nowait skipifsilent; Check: ShouldOpen

[Code]
var
  Progress: TOutputProgressWizardPage;

function HasFlag(const Flag: String): Boolean;
var I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Flag) = 0 then begin Result := True; Exit; end;
end;

// The isolated smoke check uses the production installer. It creates no Start
// menu entries or uninstall registration and keeps its speech under the test dir.
function FixtureInstall: Boolean;
begin
  Result := HasFlag('/SANDBOXINSTALL');
end;
function ShouldOpen: Boolean;
begin
  Result := not FixtureInstall and not HasFlag('/NOAUTOOPEN');
end;

procedure InitializeWizard();
begin
  Progress := CreateOutputProgressPage('Preparing En-GYM', 'Checking and preparing local speech components.');
end;

function SetEnvironmentVariable(const Name, Value: String): Boolean;
external 'SetEnvironmentVariableW@kernel32.dll stdcall';

procedure OutputLine(const S: String; const Error, FirstLine: Boolean);
var Slash, Space, N, D: Integer; Tail: String;
begin
  if Error or (Length(S) > 500) then Exit;
  Slash := Pos('/', S);
  if Slash > 1 then begin
    N := StrToIntDef(Copy(S,1,Slash-1), -1);
    Tail := Copy(S,Slash+1,Length(S)); Space := Pos(' ', Tail);
    if Space > 0 then Tail := Copy(Tail,1,Space-1);
    D := StrToIntDef(Tail, -1);
    if (N >= 0) and (D > 0) then begin
      Progress.SetProgress(N,D);
      Progress.SetText('Preparing local speech', 'Downloading and checking the English voices and speech recognition files.');
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Base, Speech, Temp, PowerShell: String; ExitCode: Integer;
begin
  Result := '';
  if HasFlag('/UPDATE') then Exit;
  Temp := ExpandConstant('{tmp}\bootstrap');
  Base := ExpandConstant('{localappdata}');
  if FixtureInstall then Base := ExpandConstant('{app}\sandbox-profile');
  Speech := Base + '\En-GYM\components\speech';
  Progress.Show;
  try
    try
      Progress.SetText('Preparing local speech', 'Checking installed components…');
      ExtractTemporaryFiles('{tmp}\bootstrap\*');
      SetEnvironmentVariable('FIELDWORK_INSTALL_ROOT',Temp);
      SetEnvironmentVariable('FIELDWORK_SPEECH',Speech);
      SetEnvironmentVariable('LOCALAPPDATA',Base);
      SetEnvironmentVariable('EN_GYM_INSTALLED','1');
      SetEnvironmentVariable('NODE_OPTIONS',''); SetEnvironmentVariable('NODE_PATH','');
      SetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED',''); SetEnvironmentVariable('NODE_EXTRA_CA_CERTS','');
      if not ExecAndLogOutput(Temp + '\runtime\node.exe', 'packaging/prepare-speech.mjs', Temp,
        SW_HIDE, ewWaitUntilTerminated, ExitCode, @OutputLine) or (ExitCode <> 0) then
        Result := 'Speech setup could not finish. Check your internet connection and retry.';
      if Result = '' then begin
        Progress.SetText('Preparing local speech', 'Checking the Microsoft Visual C++ Runtime.');
        PowerShell := ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe');
        if not FileExists(PowerShell) then PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
        if not ExecAndLogOutput(PowerShell, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Temp +
          '\packaging\verify-vc.ps1" -Speech "' + Speech + '"', Temp, SW_HIDE, ewWaitUntilTerminated, ExitCode, @OutputLine)
          or (ExitCode <> 0) then Result := 'The Microsoft runtime for local speech could not be prepared. Check your connection and retry.';
      end;
    except
      Result := 'Setup could not prepare your local speech tools. ' + GetExceptionMessage;
    end;
  finally
    Progress.Hide;
  end;
end;
