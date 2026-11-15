param(
  [string]$CompilerPath,
  [string]$NodePath,
  [switch]$SkipBuild,
  [switch]$CheckPayload
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pack = Join-Path $root 'packaging'
$work = Join-Path $root '.work'
$output = Join-Path $work 'release'
$nodeVersion = '24.22.2'
$nodeHash = '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9'
if (!$NodePath) { $NodePath = Join-Path $work 'node-win/node.exe' }
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { $NodePath = (Get-Command node.exe).Source }
if ((Get-FileHash -LiteralPath $NodePath).Hash -ne $nodeHash) {
  throw "Use the official Windows x64 node.exe from Node $nodeVersion (pass -NodePath)."
}
if (!$CompilerPath) {
  $CompilerPath = Join-Path $work 'inno6/ISCC.exe'
  if (!(Test-Path -LiteralPath $CompilerPath -PathType Leaf) -or
    (Get-FileHash -LiteralPath $CompilerPath).Hash -ne 'f02fa0e5f237b47d7ed1edae9b991866ec94fe02af61eb6a73e94f92fe8e0604') {
    $toolsDir = Split-Path $CompilerPath
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $download = Join-Path $work ('compiler-' + [guid]::NewGuid().ToString('N') + '.exe')
    try {
      $curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
      & $curl -fsSL --retry 2 --max-time 180 -o $download 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_4/innosetup-6.7.4.exe'
      if ($LASTEXITCODE -or (Get-FileHash -LiteralPath $download).Hash -ne 'a549929319f9120716677c685535ca4671e4b937b5fdc87e2585f32d8eb30e8c') {
        throw 'Could not verify the pinned Inno Setup download.'
      }
      $signature = Get-AuthenticodeSignature -LiteralPath $download
      if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Pyrsys B\.V\.(?:,|$)') {
        throw 'The Inno Setup publisher signature is invalid.'
      }
      $tool = Start-Process -Wait -PassThru -WindowStyle Hidden -FilePath $download -ArgumentList @(
        '/PORTABLE=1','/CURRENTUSER','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS',('/DIR="{0}"' -f $toolsDir))
      if ($tool.ExitCode) { throw 'Could not prepare the installer compiler.' }
    } finally { if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force } }
  }
}
if (!(Test-Path -LiteralPath $CompilerPath -PathType Leaf)) {
  throw 'Install Inno Setup 6.7.4 or pass its ISCC.exe path with -CompilerPath.'
}
$originalEnv = @{}
foreach ($key in @('LOCALAPPDATA','FIELDWORK_SPEECH','FIELDWORK_INSTALL_ROOT','EN_GYM_INSTALLED')) {
  $originalEnv[$key] = [Environment]::GetEnvironmentVariable($key)
}
Push-Location -LiteralPath $root
try {
  if (!$SkipBuild) {
    & $NodePath 'node_modules/typescript/bin/tsc' --noEmit
    if ($LASTEXITCODE) { throw 'TypeScript check failed.' }
    & $NodePath 'node_modules/vite/bin/vite.js' build
    if ($LASTEXITCODE) { throw 'Frontend build failed.' }
  }
  New-Item -ItemType Directory -Force -Path $work,$output | Out-Null
  . (Join-Path $PSScriptRoot 'build-directory.ps1')
  Invoke-InBuildDirectory {
    param($scratch)
    $payload = Join-Path $scratch 'app'
    $bootstrap = Join-Path $scratch 'bootstrap'
    foreach ($target in @($payload,$bootstrap)) {
      New-Item -ItemType Directory -Path (Join-Path $target 'scripts') -Force | Out-Null
      Copy-Item -LiteralPath 'package.json' -Destination $target
      Copy-Item -LiteralPath 'scripts/release-trust.json','scripts/release-apply.mjs','scripts/release-bootstrap.mjs' -Destination (Join-Path $target 'scripts')
    }
    New-Item -ItemType Directory -Path (Join-Path $payload 'runtime') | Out-Null
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $payload 'runtime/node.exe')
    Copy-Item -LiteralPath 'dist','core','server' -Destination $payload -Recurse
    Copy-Item -LiteralPath 'LICENSE','THIRD-PARTY.md' -Destination $payload
    Copy-Item -LiteralPath 'packaging/licenses' -Destination $payload -Recurse
    foreach ($library in @('react','react-dom','scheduler')) {
      Copy-Item -LiteralPath "node_modules/$library/LICENSE" -Destination (Join-Path $payload "licenses/$library.txt")
    }
    $nodeLicense = Join-Path (Split-Path -Parent $NodePath) 'LICENSE'
    if (!(Test-Path -LiteralPath $nodeLicense)) { throw 'The official Node LICENSE must be beside node.exe.' }
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $payload 'runtime/LICENSE')
    $modules = New-Item -Type Directory -Path (Join-Path $payload 'node_modules')
    Copy-Item -LiteralPath 'node_modules/jose','node_modules/phonon-tts' -Destination $modules.FullName -Recurse
    New-Item -ItemType Directory -Path (Join-Path $bootstrap 'packaging'),(Join-Path $bootstrap 'core'),(Join-Path $bootstrap 'server') | Out-Null
    Copy-Item -LiteralPath 'packaging/speech-baseline.json','packaging/verify-vc.ps1','packaging/prepare-speech.mjs' -Destination (Join-Path $bootstrap 'packaging')
    Copy-Item -LiteralPath 'scripts/phonon-assets.json','scripts/release-versions.json' -Destination (Join-Path $bootstrap 'scripts')
    Copy-Item -LiteralPath 'core/updates.ts' -Destination (Join-Path $bootstrap 'core')
    Copy-Item -LiteralPath 'server/updates.ts' -Destination (Join-Path $bootstrap 'server')

    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a three-part stable version.' }
    $attributes = Join-Path $scratch 'Version.cs'
    Set-Content -LiteralPath $attributes -Encoding Ascii -Value @(
      'using System.Reflection;',('[assembly: AssemblyVersion("{0}.0")]' -f $version),
      ('[assembly: AssemblyFileVersion("{0}.0")]' -f $version),'[assembly: AssemblyProduct("En-GYM")]'
    )
    $logo = Join-Path $pack 'En-GYM.ico'
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/win32icon:$logo" "/out:$payload\En-GYM.exe" (Join-Path $pack 'Tray.cs') $attributes
    if ($LASTEXITCODE) { throw 'Native tray build failed.' }
    if ($CheckPayload) {
      $profile = Join-Path $scratch 'isolated-profile'
      $env:LOCALAPPDATA = $profile
      $env:FIELDWORK_SPEECH = Join-Path $profile 'En-GYM/components/speech'
      $env:FIELDWORK_INSTALL_ROOT = $bootstrap
      $env:EN_GYM_INSTALLED = '1'
      # Start from empty storage. A second bootstrap verifies the repair path.
      & $NodePath (Join-Path $bootstrap 'packaging/prepare-speech.mjs')
      if ($LASTEXITCODE) { throw 'Staged speech integrity check failed.' }
      & $NodePath (Join-Path $bootstrap 'packaging/prepare-speech.mjs')
      if ($LASTEXITCODE) { throw 'Speech repair with existing receipts failed.' }
      $env:FIELDWORK_INSTALL_ROOT = $payload
      Push-Location -LiteralPath $payload
      try {
        & (Join-Path $payload 'runtime/node.exe') (Join-Path $pack 'check-installed.mjs')
        if ($LASTEXITCODE) { throw 'Packaged application smoke check failed.' }
      } finally { Pop-Location }
    }
    $compiled = (New-Item -ItemType Directory -Path (Join-Path $scratch 'output')).FullName
    & $CompilerPath /Qp "/DProductVersion=$version" "/DPayload=$payload" "/DBootstrap=$bootstrap" "/DOutputFolder=$compiled" "/DLogoFile=$logo" (Join-Path $pack 'En-GYM.iss')
    if ($LASTEXITCODE) { throw 'Windows installer compilation failed.' }
    $setup = Join-Path $compiled 'En-GYM-Setup.exe'
    $final = Join-Path $output 'En-GYM-Setup.exe'
    if ([IO.File]::Exists($final)) { [IO.File]::Replace($setup,$final,[NullString]::Value) }
    else { [IO.File]::Move($setup,$final) }
  }
  Get-Item -LiteralPath (Join-Path $output 'En-GYM-Setup.exe') | Select-Object FullName,Length
} finally {
  foreach ($key in $originalEnv.Keys) { [Environment]::SetEnvironmentVariable($key,$originalEnv[$key]) }
  Pop-Location
}
