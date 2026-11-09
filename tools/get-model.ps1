# Downloads the offline English voice model (Vosk, ~40 MB) and packs it for VoiceTag.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force -Path 'model' | Out-Null
$out = Join-Path (Get-Location) 'model\model.tar.gz'
$name = 'vosk-model-small-en-us-0.15'
$tmp = Join-Path $env:TEMP 'voicetag_model'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Try-Official {
  Write-Host '      downloading from alphacephei.com ...'
  Invoke-WebRequest "https://alphacephei.com/vosk/models/$name.zip" -OutFile "$tmp\m.zip" -UseBasicParsing
  Expand-Archive "$tmp\m.zip" -DestinationPath $tmp -Force
  if (-not (Test-Path "$tmp\$name\am")) { throw 'Unexpected model contents' }
  & tar.exe -czf $out -C $tmp $name
  if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
}
function Try-Mirror {
  Write-Host '      trying the mirror ...'
  Invoke-WebRequest "https://ccoreilly.github.io/vosk-browser/models/$name.tar.gz" -OutFile $out -UseBasicParsing
}

try { Try-Official }
catch {
  Write-Host ('      first source failed: ' + $_.Exception.Message)
  try { Try-Mirror }
  catch {
    Write-Host ('      mirror failed too: ' + $_.Exception.Message)
    if (Test-Path $out) { Remove-Item $out -Force }
    exit 1
  }
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
$size = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "      voice model ready ($size MB)."
exit 0
