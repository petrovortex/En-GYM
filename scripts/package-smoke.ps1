param([string]$Installer)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$Installer) { $Installer=Join-Path $root '.work/release/En-GYM-Setup.exe' }
if (!(Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'Build the installer first.' }
$qa=[IO.Path]::GetFullPath((Join-Path $root '.work'))
$sandbox=(New-Item -ItemType Directory -Path (Join-Path $qa ('setup-check-'+[guid]::NewGuid().ToString('N')))).FullName
$app=Join-Path $sandbox 'Installed En-GYM'
$profile=Join-Path $app 'sandbox-profile'
$log=Join-Path $sandbox 'setup.log'
$originalEnv=@{}
foreach ($key in @('PATH','LOCALAPPDATA','FIELDWORK_SPEECH','FIELDWORK_DATA','FIELDWORK_INSTALL_ROOT','EN_GYM_INSTALLED')) {
  $originalEnv[$key]=[Environment]::GetEnvironmentVariable($key)
}
try {
  # Exercise the end-user path even on runners shipping global Python and Node.
  $env:PATH=[Environment]::SystemDirectory
  $flags=@('/SANDBOXINSTALL','/CURRENTUSER','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS','/NOAUTOOPEN',
    ('/DIR="{0}"' -f $app),('/LOG="{0}"' -f $log))
  $p=Start-Process -FilePath $Installer -ArgumentList $flags -WindowStyle Hidden -PassThru -Wait
  if ($p.ExitCode) { Get-Content -LiteralPath $log -Tail 35; throw "Installer exit $($p.ExitCode)" }
  $localNode=Join-Path $app 'runtime/node.exe'
  foreach($f in @('En-GYM.exe','dist/index.html','core/updates.ts','server/main.ts','runtime/LICENSE','scripts/release-apply.mjs')) {
    if (!(Test-Path -LiteralPath (Join-Path $app $f) -PathType Leaf)) { throw "Missing packaged file: $f" }
  }
  $env:LOCALAPPDATA=$profile
  $env:FIELDWORK_SPEECH=Join-Path $profile 'En-GYM/components/speech'
  $env:FIELDWORK_DATA=Join-Path $profile 'En-GYM/user'
  $env:FIELDWORK_INSTALL_ROOT=$app
  $env:EN_GYM_INSTALLED='1'
  Push-Location -LiteralPath $app
  try {
    & $localNode (Join-Path $root 'packaging/check-installed.mjs')
    if ($LASTEXITCODE) { throw 'Installed app smoke check failed.' }
  } finally { Pop-Location }
  $bytes=(Get-ChildItem -LiteralPath $app -File -Recurse | Measure-Object Length -Sum).Sum
  Write-Output ("Fresh installer, speech download, synthesis, transcription and private server passed ({0:N1} MiB in isolated installation)." -f ($bytes/1MB))
} finally {
  foreach ($key in $originalEnv.Keys) { [Environment]::SetEnvironmentVariable($key,$originalEnv[$key]) }
  $verified=Get-Item -LiteralPath $sandbox
  if ($verified.Parent.FullName -ne $qa -or $verified.Name -notmatch '^setup-check-[0-9a-f]{32}$' -or
    ($verified.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected smoke-test directory.' }
  Remove-Item -LiteralPath $verified.FullName -Recurse -Force
}
