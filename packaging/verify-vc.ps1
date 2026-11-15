param([Parameter(Mandatory)][string]$Speech)
$ErrorActionPreference = 'Stop'
$runtime = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
$recognizer = Join-Path $Speech 'asr\whisper-cli.exe'
function Test-Recognizer {
  if (!(Test-Path -LiteralPath $recognizer -PathType Leaf)) { return $false }
  $p = Start-Process -FilePath $recognizer -ArgumentList '--help' -WorkingDirectory (Split-Path $recognizer) -PassThru -Wait -WindowStyle Hidden
  if ($p.ExitCode -eq 0) { return $true }
  if ($p.ExitCode -eq -1073741515) { return $false } # Windows STATUS_DLL_NOT_FOUND
  throw 'Windows could not run local speech tools. Check application permissions and run setup again.'
}
if ($runtime.Installed -eq 1 -and $runtime.Major -ge 14 -and (Test-Recognizer)) { exit 0 }
Write-Output 'Checking the Microsoft Visual C++ Runtime…'
$installer = Join-Path $PSScriptRoot 'vc_redist.x64.exe'
$curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
& $curl -fsSL --retry 2 --max-time 180 -o $installer 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
if ($LASTEXITCODE -ne 0) { throw 'Cannot download the Microsoft runtime. Check your connection and retry.' }
$sig = Get-AuthenticodeSignature -LiteralPath $installer
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)') {
  throw 'The Microsoft runtime signature could not be verified.'
}
$p = Start-Process -FilePath $installer -ArgumentList '/install','/passive','/norestart' -Verb RunAs -Wait -PassThru
if ($p.ExitCode -notin @(0,1638,3010) -or !(Test-Recognizer)) {
  throw 'Cannot start local speech. Restart Windows if requested and run setup again.'
}
