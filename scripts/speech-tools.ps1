$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'build-directory.ps1')
$speech = Join-Path $root '.work/speech'
New-Item -ItemType Directory -Path $speech -Force | Out-Null
$node = Join-Path $root '.work/node-win/node.exe'
if (!(Test-Path -LiteralPath $node)) { throw 'Open Start En-GYM.cmd to install the development runtime first.' }
& $node (Join-Path $PSScriptRoot 'install-phonon.mjs')
if ($LASTEXITCODE) { throw 'The local Phonon voices could not be installed. Check your connection and open the launcher again.' }
function Fetch($label,$name,$url,$sha) {
  $path = Join-Path $cache $name
  if (!(Test-Path $path) -or (Get-FileHash $path).Hash -ne $sha) {
    Write-Host "Downloading $label..."
    curl.exe -fL --progress-bar --retry 3 -o $path $url
    if ($LASTEXITCODE -ne 0 -or (Get-FileHash $path).Hash -ne $sha) { throw "Download failed verification: $name" }
  }
  return $path
}
$asrFiles = @('asr/whisper-cli.exe','asr/whisper.dll','asr/ggml.dll','asr/ggml-base.dll','asr/ggml-cpu.dll','asr/SDL2.dll','ggml-base.en-q5_1.bin')
if ($asrFiles | Where-Object { !(Test-Path -LiteralPath (Join-Path $speech $_)) }) {
  Invoke-InBuildDirectory {
    param($cache)
    $asr = Fetch 'the speech recognizer' 'whisper.zip' 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip' '0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9'
    $model = Fetch 'English transcription data' 'ggml-base.en-q5_1.bin' 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en-q5_1.bin' '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f'
    Copy-Item -LiteralPath $model -Destination $speech -Force
    tar.exe -xf $asr -C $cache
    if ($LASTEXITCODE) { throw 'Cannot unpack the speech recognizer.' }
    $exe = Get-ChildItem -Path (Join-Path $cache 'Release') -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
    if (!$exe) { throw 'Missing whisper-cli.exe' }
    $dir = Join-Path $speech 'asr'
    New-Item -ItemType Directory -Force $dir | Out-Null
    Copy-Item -LiteralPath $exe.FullName -Destination $dir -Force
    Get-ChildItem -Path $exe.DirectoryName -Filter '*.dll' | Copy-Item -Destination $dir -Force
  }
}
Write-Output "Offline speech engines are ready in $speech."

